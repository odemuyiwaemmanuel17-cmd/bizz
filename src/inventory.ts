/**
 * Inventory ledger.
 *
 * Stock is modelled as `onHand - reserved = available`. Orders *reserve* stock
 * (soft allocation, instantly reflected in availability) and later *commit* the
 * reservation when the seller ships. Everything is guarded by optimistic
 * version checks so two concurrent checkout requests can never oversell.
 */

import { ConflictError, InsufficientStockError, NotFoundError, StaleVersionError, ValidationError } from './errors.js';
import type { Clock, IdPrefix } from './id.js';
import { SequentialIdGenerator } from './id.js';
import { nonNegativeInteger, positiveInteger } from './schema.js';
import type { Sku, StockLevel, StockRecord } from './types.js';
import { availableQuantity, stockLevelOf } from './types.js';

const ID_KIND: IdPrefix = 'stk';

export interface StockMovement {
  readonly movementId: string;
  readonly skuId: string;
  /** Positive increases on-hand/released reservations, negative decreases them. */
  readonly delta: number;
  readonly kind: 'receive' | 'adjust' | 'reserve' | 'release' | 'commit' | 'shrinkage';
  readonly at: string;
  readonly actorId: string;
  readonly reference?: string;
  readonly balanceAfter: number;
  readonly reservedAfter: number;
}

export interface StockLedger {
  append(movement: StockMovement): Promise<void>;
  history(skuId: string): Promise<readonly StockMovement[]>;
}

export interface StockRepository {
  find(skuId: string): Promise<StockRecord | undefined>;
  save(record: StockRecord, expectedVersion: number): Promise<StockRecord>;
}

export interface AdjustInput {
  readonly skuId: string;
  readonly delta: number;
  readonly actorId: string;
  readonly reason: string;
  readonly expectedVersion?: number;
  readonly reference?: string;
}

export interface ReserveInput {
  readonly skuId: string;
  readonly quantity: number;
  readonly actorId: string;
  readonly reference: string;
}

export interface ReservationResult {
  readonly skuId: string;
  readonly quantity: number;
  readonly record: StockRecord;
  readonly movement: StockMovement;
}

/** In-memory ledger used by tests, demos and the local dev server. */
export class InMemoryStockLedger implements StockLedger {
  private readonly entries: Map<string, StockMovement[]> = new Map();

  public async append(movement: StockMovement): Promise<void> {
    const bucket: StockMovement[] = this.entries.get(movement.skuId) ?? [];
    bucket.push(movement);
    this.entries.set(movement.skuId, bucket);
  }

  public async history(skuId: string): Promise<readonly StockMovement[]> {
    return Object.freeze([...(this.entries.get(skuId) ?? [])]);
  }
}

/** In-memory repository with real optimistic-locking semantics. */
export class InMemoryStockRepository implements StockRepository {
  private readonly records: Map<string, StockRecord> = new Map();

  public constructor(seed: readonly StockRecord[] = []) {
    for (const record of seed) this.records.set(record.skuId, record);
  }

  public async find(skuId: string): Promise<StockRecord | undefined> {
    const found: StockRecord | undefined = this.records.get(skuId);
    return found === undefined ? undefined : { ...found };
  }

  public async save(record: StockRecord, expectedVersion: number): Promise<StockRecord> {
    const current: StockRecord | undefined = this.records.get(record.skuId);
    if (current === undefined && expectedVersion !== 0) {
      throw new StaleVersionError('StockRecord', record.skuId, expectedVersion, 0);
    }
    if (current !== undefined && current.version !== expectedVersion) {
      throw new StaleVersionError('StockRecord', record.skuId, expectedVersion, current.version);
    }
    const saved: StockRecord = Object.freeze({ ...record });
    this.records.set(record.skuId, saved);
    return { ...saved };
  }

  /** Test helper: bypasses version checks. */
  public put(record: StockRecord): void {
    this.records.set(record.skuId, Object.freeze({ ...record }));
  }

  public get size(): number {
    return this.records.size;
  }
}

export interface InventoryServiceOptions {
  readonly repository: StockRepository;
  readonly ledger?: StockLedger;
  readonly clock: Clock;
  readonly idGenerator?: SequentialIdGenerator;
  /** When true, reserving more than `reorderPoint` remaining logs nothing extra. Defaults to false. */
  readonly allowBackorder?: boolean;
}

export class InventoryService {
  private readonly repository: StockRepository;
  private readonly ledger: StockLedger;
  private readonly clock: Clock;
  private readonly ids: SequentialIdGenerator;
  private readonly allowBackorder: boolean;

  public constructor(options: InventoryServiceOptions) {
    if (options.repository === undefined) throw ValidationError.field('repository', 'A stock repository is required');
    if (options.clock === undefined) throw ValidationError.field('clock', 'A clock is required');
    this.repository = options.repository;
    this.ledger = options.ledger ?? new InMemoryStockLedger();
    this.clock = options.clock;
    this.ids = options.idGenerator ?? new SequentialIdGenerator('inventory');
    this.allowBackorder = options.allowBackorder ?? false;
  }

  /* ---------------------------- read side -------------------------------- */

  public async get(skuId: string): Promise<StockRecord> {
    return await this.load(skuId);
  }

  /** Non-throwing variant of `get`; returns `undefined` for unknown SKUs. */
  public async find(skuId: string): Promise<StockRecord | undefined> {
    if (typeof skuId !== 'string' || skuId.trim().length === 0) {
      throw ValidationError.field('skuId', 'SKU id is required');
    }
    return await this.repository.find(skuId);
  }

  public async availability(skuId: string): Promise<{ readonly available: number; readonly level: StockLevel }> {
    const record: StockRecord = await this.load(skuId);
    return { available: availableQuantity(record), level: stockLevelOf(record) };
  }

  public async history(skuId: string): Promise<readonly StockMovement[]> {
    return await this.ledger.history(skuId);
  }

  /** Batch check used by cart validation; never throws for missing SKUs. */
  public async checkLines(
    lines: readonly { readonly skuId: string; readonly quantity: number }[],
  ): Promise<readonly { readonly skuId: string; readonly available: number; readonly requested: number; readonly ok: boolean }[]> {
    const out: { skuId: string; available: number; requested: number; ok: boolean }[] = [];
    for (const line of lines) {
      const record: StockRecord | undefined = await this.find(line.skuId);
      const available: number = record === undefined ? 0 : availableQuantity(record);
      out.push({ skuId: line.skuId, available, requested: line.quantity, ok: available >= line.quantity });
    }
    return Object.freeze(out);
  }

  /* --------------------------- write side -------------------------------- */

  /** Create or top-up a stock record from a receiving document. */
  public async receive(input: {
    readonly skuId: string;
    readonly quantity: number;
    readonly actorId: string;
    readonly reference: string;
    readonly reorderPoint?: number;
    readonly locationCode?: string;
  }): Promise<StockRecord> {
    const quantity: number = positiveInteger()(input.quantity);
    const existing: StockRecord | undefined = await this.find(input.skuId);
    if (existing === undefined) {
      const created: StockRecord = Object.freeze({
        skuId: input.skuId,
        onHand: quantity,
        reserved: 0,
        reorderPoint: input.reorderPoint ?? 0,
        locationCode: input.locationCode,
        version: 1,
        updatedAt: this.clock.now().toISOString(),
      });
      const saved: StockRecord = await this.repository.save(created, 0);
      await this.appendMovement(saved, quantity, 0, 'receive', input.actorId, input.reference);
      return saved;
    }
    const next: StockRecord = await this.write(existing, {
      onHand: existing.onHand + quantity,
      reorderPoint: input.reorderPoint ?? existing.reorderPoint,
      locationCode: input.locationCode ?? existing.locationCode,
    });
    await this.appendMovement(next, quantity, 0, 'receive', input.actorId, input.reference);
    return next;
  }

  /** Manual seller/admin correction. Resulting on-hand may not go negative. */
  public async adjust(input: AdjustInput): Promise<StockRecord> {
    const reason: string = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length === 0) throw ValidationError.field('reason', 'An adjustment reason is required');
    if (!Number.isFinite(input.delta) || !Number.isInteger(input.delta)) {
      throw ValidationError.field('delta', 'Delta must be a whole number of units');
    }
    if (input.delta === 0) throw ValidationError.field('delta', 'Delta must not be zero');
    const current: StockRecord = await this.load(input.skuId);
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new StaleVersionError('StockRecord', input.skuId, input.expectedVersion, current.version);
    }
    const projectedOnHand: number = current.onHand + input.delta;
    if (projectedOnHand < current.reserved) {
      throw new ConflictError(
        `Cannot reduce stock of '${input.skuId}' to ${String(projectedOnHand)} while ${String(current.reserved)} unit(s) are reserved`,
        { skuId: input.skuId, projectedOnHand, reserved: current.reserved },
      );
    }
    const kind: StockMovement['kind'] = input.delta < 0 ? 'shrinkage' : 'adjust';
    const next: StockRecord = await this.write(current, { onHand: projectedOnHand });
    await this.appendMovement(next, input.delta, 0, kind, input.actorId, input.reference ?? reason);
    return next;
  }

  /** Configure the reorder point / bin location without touching quantities. */
  public async configure(input: {
    readonly skuId: string;
    readonly reorderPoint: number;
    readonly locationCode?: string;
    readonly actorId: string;
  }): Promise<StockRecord> {
    const current: StockRecord = await this.load(input.skuId);
    return await this.write(current, {
      reorderPoint: nonNegativeInteger()(input.reorderPoint),
      locationCode: input.locationCode ?? current.locationCode,
    });
  }

  /**
   * Soft-allocate stock for a checkout line. Throws `InsufficientStockError`
   * unless back-orders are explicitly enabled.
   */
  public async reserve(input: ReserveInput): Promise<ReservationResult> {
    const quantity: number = positiveInteger()(input.quantity);
    if (typeof input.reference !== 'string' || input.reference.trim().length === 0) {
      throw ValidationError.field('reference', 'A reservation reference (cart/order id) is required');
    }
    const current: StockRecord = await this.load(input.skuId);
    const available: number = availableQuantity(current);
    if (available < quantity && !this.allowBackorder) {
      throw new InsufficientStockError(input.skuId, quantity, available);
    }
    const next: StockRecord = await this.write(current, { reserved: current.reserved + quantity });
    const movement: StockMovement = await this.appendMovement(next, 0, quantity, 'reserve', input.actorId, input.reference);
    return { skuId: input.skuId, quantity, record: next, movement };
  }

  /** Give reserved units back to the pool (cart abandoned, order cancelled). */
  public async release(input: ReserveInput): Promise<ReservationResult> {
    const quantity: number = positiveInteger()(input.quantity);
    const current: StockRecord = await this.load(input.skuId);
    if (current.reserved < quantity) {
      throw new ConflictError(
        `Cannot release ${String(quantity)} unit(s) of '${input.skuId}': only ${String(current.reserved)} reserved`,
        { skuId: input.skuId, reserved: current.reserved },
      );
    }
    const next: StockRecord = await this.write(current, { reserved: current.reserved - quantity });
    const movement: StockMovement = await this.appendMovement(next, 0, -quantity, 'release', input.actorId, input.reference);
    return { skuId: input.skuId, quantity, record: next, movement };
  }

  /** Consume a reservation and decrement on-hand (called on shipment). */
  public async commit(input: ReserveInput): Promise<ReservationResult> {
    const quantity: number = positiveInteger()(input.quantity);
    const current: StockRecord = await this.load(input.skuId);
    if (current.reserved < quantity) {
      throw new ConflictError(
        `Cannot commit ${String(quantity)} unit(s) of '${input.skuId}': only ${String(current.reserved)} reserved`,
        { skuId: input.skuId, reserved: current.reserved },
      );
    }
    if (current.onHand < quantity) {
      throw new ConflictError(
        `Cannot commit ${String(quantity)} unit(s) of '${input.skuId}': only ${String(current.onHand)} on hand`,
        { skuId: input.skuId, onHand: current.onHand },
      );
    }
    const next: StockRecord = await this.write(current, {
      onHand: current.onHand - quantity,
      reserved: current.reserved - quantity,
    });
    const movement: StockMovement = await this.appendMovement(next, -quantity, -quantity, 'commit', input.actorId, input.reference);
    return { skuId: input.skuId, quantity, record: next, movement };
  }

  /** Reserve many lines atomically; on failure everything already reserved rolls back. */
  public async reserveAll(
    lines: readonly ReserveInput[],
  ): Promise<readonly ReservationResult[]> {
    if (!Array.isArray(lines) || lines.length === 0) return Object.freeze([]);
    const done: ReservationResult[] = [];
    try {
      for (const line of lines) done.push(await this.reserve(line));
    } catch (error) {
      for (let index = done.length - 1; index >= 0; index -= 1) {
        const reservation: ReservationResult = done[index] as ReservationResult;
        await this.release({
          skuId: reservation.skuId,
          quantity: reservation.quantity,
          actorId: 'system:compensation',
          reference: `rollback:${reservation.movement.movementId}`,
        });
      }
      throw error;
    }
    return Object.freeze(done);
  }

  /** Guard used at checkout: MOQ + pack step + availability in one call. */
  public async assertPurchasable(sku: Sku, quantity: number): Promise<number> {
    const parsed: number = positiveInteger()(quantity);
    if (parsed < sku.minOrderQuantity) {
      throw ValidationError.field('quantity', `Minimum order quantity for '${sku.skuCode}' is ${String(sku.minOrderQuantity)}`);
    }
    if (sku.quantityStep > 1 && parsed % sku.quantityStep !== 0) {
      throw ValidationError.field('quantity', `Quantity for '${sku.skuCode}' must be a multiple of ${String(sku.quantityStep)}`);
    }
    const record: StockRecord = await this.load(sku.id);
    const available: number = availableQuantity(record);
    if (available < parsed) throw new InsufficientStockError(sku.id, parsed, available);
    return parsed;
  }

  /* ----------------------------- internals ------------------------------- */

  private async load(skuId: string): Promise<StockRecord> {
    if (typeof skuId !== 'string' || skuId.trim().length === 0) {
      throw ValidationError.field('skuId', 'SKU id is required');
    }
    const record: StockRecord | undefined = await this.repository.find(skuId);
    if (record === undefined) throw new NotFoundError('StockRecord', skuId);
    return record;
  }

  private async write(current: StockRecord, patch: Partial<Omit<StockRecord, 'skuId' | 'version'>>): Promise<StockRecord> {
    const candidate: StockRecord = Object.freeze({
      ...current,
      ...patch,
      onHand: patch.onHand ?? current.onHand,
      reserved: patch.reserved ?? current.reserved,
      version: current.version + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    if (candidate.onHand < 0) throw new ConflictError(`Stock of '${candidate.skuId}' cannot go negative`);
    if (candidate.reserved < 0) throw new ConflictError(`Reservations of '${candidate.skuId}' cannot go negative`);
    if (candidate.reserved > candidate.onHand) {
      throw new ConflictError(
        `Reserved units (${String(candidate.reserved)}) exceed on-hand stock (${String(candidate.onHand)}) for '${candidate.skuId}'`,
      );
    }
    return await this.repository.save(candidate, current.version);
  }

  private async appendMovement(
    record: StockRecord,
    onHandDelta: number,
    reservedDelta: number,
    kind: StockMovement['kind'],
    actorId: string,
    reference?: string,
  ): Promise<StockMovement> {
    const movement: StockMovement = Object.freeze({
      movementId: this.ids.next(ID_KIND),
      skuId: record.skuId,
      delta: onHandDelta + reservedDelta,
      kind,
      at: record.updatedAt,
      actorId,
      reference,
      balanceAfter: record.onHand,
      reservedAfter: record.reserved,
    });
    await this.ledger.append(movement);
    return movement;
  }
}
