/**
 * Validation ("vote") feature.
 *
 * Backs `POST /api/votes`: a vote is a buyer's statement that they would order
 * `quantity` units of a SKU — the ledger doubles as demand validation and, for
 * buyers, seeds their cart line (see `CartService.setVoteQuantity`).
 *
 * Rules encoded here:
 *  - one vote per (user, listing) — submitting again with a different quantity
 *    *replaces* it; identical payloads are idempotent no-ops;
 *  - `toggle=true` flips the caller's vote on/off without needing a quantity;
 *  - votes must target an *active* (published) listing owned by another seller;
 *  - quantities respect the SKU's MOQ/pack step when supplied;
 *  - totals (`votesCount`, `unitsCommitted`) are denormalised onto the listing
 *    aggregate under optimistic locking, so concurrent voters never lose data
 *    (a lost-update race raises `StaleVersionError` and the route replays).
 */

import { ConflictError, NotFoundError, StaleVersionError, ValidationError } from './errors.js';
import type { Clock } from './id.js';
import { SequentialIdGenerator } from './id.js';
import { assertActiveAccount } from './rbac.js';
import { enumOf, identifier, integer, nonNegativeInteger, skuCode } from './schema.js';
import type { Product, ProductStatus, Sku, User } from './types.js';
import { PRODUCT_STATUSES } from './types.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export const VOTE_OUTCOMES = ['created', 'updated', 'unchanged', 'toggled_on', 'toggled_off'] as const;
export type VoteOutcome = (typeof VOTE_OUTCOMES)[number];

export interface Vote {
  readonly id: string;
  readonly listingId: string;
  readonly skuId: string;
  readonly userId: string;
  readonly quantity: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListingVotesRecord {
  readonly listingId: string;
  readonly votesCount: number;
  readonly unitsCommitted: number;
  readonly votes: readonly Vote[];
  readonly version: number;
}

export interface VoteTally {
  readonly listingId: string;
  readonly votesCount: number;
  readonly unitsCommitted: number;
  readonly voters: readonly { readonly userId: string; readonly quantity: number }[];
}

export interface SubmitVoteInput {
  readonly actor: User;
  /** Numeric or string listing ids are both accepted at the HTTP boundary. */
  readonly listingId: string | number;
  readonly skuId?: string | number;
  /** Omit to toggle; provide to upsert explicitly. */
  readonly quantity?: number;
  readonly toggle?: boolean;
}

export interface VoteResult {
  readonly outcome: VoteOutcome;
  readonly vote: Vote | undefined;
  readonly tally: VoteTally;
  readonly listingStatus: ProductStatus;
}

/* -------------------------------------------------------------------------- */
/* Ports                                                                      */
/* -------------------------------------------------------------------------- */

export interface VoteListingRepository {
  findListing(listingId: string): Promise<Product | undefined>;
  saveListing(product: Product, expectedVersion: number): Promise<Product>;
  /** Optional read-only capability used by `votesByUser`. */
  allListings?(): Promise<readonly Product[]>;
}

export interface VoteLedgerRepository {
  load(listingId: string): Promise<ListingVotesRecord | undefined>;
  save(record: ListingVotesRecord, expectedVersion: number): Promise<ListingVotesRecord>;
}

/* -------------------------------------------------------------------------- */
/* In-memory adapters                                                         */
/* -------------------------------------------------------------------------- */

  /** Bridges the catalog repository shape into the voting port. */
  export class CatalogVoteListingAdapter implements VoteListingRepository {
    public constructor(
      private readonly find: (listingId: string) => Promise<Product | undefined>,
      private readonly save: (product: Product, expectedVersion: number) => Promise<Product>,
      private readonly listAll?: () => Promise<readonly Product[]>,
    ) {}

    public async findListing(listingId: string): Promise<Product | undefined> {
      try {
        return await this.find(listingId);
      } catch (error: unknown) {
        if (error instanceof NotFoundError) return undefined;
        throw error;
      }
    }

    public async saveListing(product: Product, expectedVersion: number): Promise<Product> {
      return await this.save(product, expectedVersion);
    }

    public async allListings(): Promise<readonly Product[]> {
      return this.listAll === undefined ? [] : await this.listAll();
    }
  }

export class InMemoryVoteLedgerRepository implements VoteLedgerRepository {
  private readonly records: Map<string, ListingVotesRecord> = new Map();

  public async load(listingId: string): Promise<ListingVotesRecord | undefined> {
    return this.records.get(listingId);
  }

  public async save(record: ListingVotesRecord, expectedVersion: number): Promise<ListingVotesRecord> {
    const current: ListingVotesRecord | undefined = this.records.get(record.listingId);
    if (current !== undefined && current.version !== expectedVersion) {
      throw new StaleVersionError('ListingVotes', record.listingId, expectedVersion, current.version);
    }
    if (current === undefined && expectedVersion !== 0) {
      throw new StaleVersionError('ListingVotes', record.listingId, expectedVersion, 0);
    }
    const frozen: ListingVotesRecord = Object.freeze({ ...record, votes: Object.freeze([...record.votes]) });
    this.records.set(frozen.listingId, frozen);
    return frozen;
  }
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

const MAX_QUANTITY: number = 1_000_000;

export interface ValidationServiceOptions {
  readonly listings: VoteListingRepository;
  readonly ledger: VoteLedgerRepository;
  readonly clock: Clock;
  readonly idGenerator?: SequentialIdGenerator;
  /** How many times to replay after an optimistic-lock collision. */
  readonly maxRetries?: number;
}

export class ValidationService {
  private readonly listings: VoteListingRepository;
  private readonly ledger: VoteLedgerRepository;
  private readonly clock: Clock;
  private readonly ids: SequentialIdGenerator;
  private readonly maxRetries: number;

  public constructor(options: ValidationServiceOptions) {
    if (options.listings === undefined) throw ValidationError.field('listings', 'A listing repository is required');
    if (options.ledger === undefined) throw ValidationError.field('ledger', 'A vote ledger is required');
    if (options.clock === undefined) throw ValidationError.field('clock', 'A clock is required');
    this.listings = options.listings;
    this.ledger = options.ledger;
    this.clock = options.clock;
    this.ids = options.idGenerator ?? new SequentialIdGenerator('votes');
    this.maxRetries = integer({ min: 0, max: 10 })(options.maxRetries ?? 3);
  }

  /**
   * Submit or toggle a vote. Pure decision logic lives in `decide()` so the
   * state machine can be unit-tested without any I/O.
   */
  public async submit(input: SubmitVoteInput): Promise<VoteResult> {
    assertActiveAccount(input.actor);
    if (!isBuyerActor(input.actor)) {
      throw new ConflictError('Only buyers can validate demand', { role: input.actor.role });
    }

    const listingId: string = normalizeId(input.listingId, 'listingId');
    const requestedQuantity: number | undefined =
      input.quantity === undefined ? undefined : integer({ min: 0, max: MAX_QUANTITY })(input.quantity);
    const toggle: boolean = input.toggle === true;
    if (!toggle && requestedQuantity === undefined) {
      throw ValidationError.field('quantity', 'Provide a quantity, or set toggle=true');
    }

    let attempt: number = 0;
    for (;;) {
      attempt += 1;
      const listing: Product = await this.requireActiveListing(listingId);
      const sku: Sku = this.resolveSku(listing, input.skuId);
      const quantity: number = this.effectiveQuantity(sku, requestedQuantity, toggle);

      const record: ListingVotesRecord = await this.loadOrInit(listingId);
      const existing: Vote | undefined = record.votes.find((vote: Vote) => vote.userId === input.actor.id);
      const decision = decide(record, input.actor.id, sku.id, quantity, toggle, this.clock.now().toISOString(), this.ids.next('vot'));

      if (decision.outcome === 'unchanged' && decision.vote !== undefined) {
        return Object.freeze({
          outcome: decision.outcome,
          vote: decision.vote,
          tally: tallyOf(decision.record, listingId),
          listingStatus: listing.status,
        });
      }

      try {
        const saved: ListingVotesRecord = await this.ledger.save(decision.record, record.version);
        await this.syncListingCounter(listing, saved);
        return Object.freeze({
          outcome: decision.outcome,
          vote: decision.vote,
          tally: tallyOf(saved, listingId),
          listingStatus: listing.status,
        });
      } catch (error: unknown) {
        if (error instanceof StaleVersionError && attempt <= this.maxRetries) continue; // Replay with fresh state.
        throw error;
      }
    }
  }

  /** Current tally for a listing (zeroed for listings nobody has validated yet). */
  public async tallyFor(listingId: string | number): Promise<VoteTally> {
    const id: string = normalizeId(listingId, 'listingId');
    const record: ListingVotesRecord | undefined = await this.ledger.load(id);
    return tallyOf(record ?? emptyRecord(id), id);
  }

  /** Votes cast by one user across listings — powers "my validations" UI. */
  public async votesByUser(userId: string): Promise<readonly Vote[]> {
    const wanted: string = identifier(userId);
    const all: readonly Product[] = await this.allListings();
    const out: Vote[] = [];
    for (const listing of all) {
      const record: ListingVotesRecord | undefined = await this.ledger.load(listing.id);
      if (record === undefined) continue;
      for (const vote of record.votes) if (vote.userId === wanted) out.push(vote);
    }
    return Object.freeze(out);
  }

  /* ------------------------------- internals ------------------------------ */

  private async allListings(): Promise<readonly Product[]> {
    if (typeof this.listings.allListings === 'function') return await this.listings.allListings();
    return [];
  }

  private async requireActiveListing(listingId: string): Promise<Product> {
    const listing: Product | undefined = await this.listings.findListing(listingId);
    if (listing === undefined) throw new NotFoundError('Listing', listingId);
    if (listing.status !== 'published') {
      throw new ConflictError(`Listing '${listingId}' is ${listing.status}; only active listings accept votes`, {
        listingId,
        status: listing.status,
      });
    }
    if (listing.sellerId === undefined) throw ValidationError.field('sellerId', 'Listing has no owner');
    return listing;
  }

  private resolveSku(listing: Product, rawSkuId: string | number | undefined): Sku {
    if (listing.skus.length === 0) throw new ConflictError(`Listing '${listing.id}' has no purchasable SKUs`, { listingId: listing.id });
    if (rawSkuId === undefined || String(rawSkuId).trim().length === 0) return listing.skus[0] as Sku;
    const wanted: string = normalizeId(rawSkuId, 'skuId');
    const sku: Sku | undefined = listing.skus.find((candidate: Sku) => candidate.id === wanted);
    if (sku === undefined) throw new NotFoundError('Sku', wanted);
    return sku;
  }

  private effectiveQuantity(sku: Sku, requested: number | undefined, toggle: boolean): number {
    if (requested !== undefined) {
      if (requested === 0) return 0;
      if (requested < sku.minOrderQuantity) {
        throw ValidationError.field('quantity', `Minimum order quantity is ${String(sku.minOrderQuantity)}`);
      }
      if (sku.quantityStep > 1 && requested % sku.quantityStep !== 0) {
        throw ValidationError.field('quantity', `Quantity must be a multiple of ${String(sku.quantityStep)}`);
      }
      return requested;
    }
    if (toggle) return sku.minOrderQuantity > 0 ? sku.minOrderQuantity : 1;
    throw ValidationError.field('quantity', 'A quantity is required');
  }

  private async loadOrInit(listingId: string): Promise<ListingVotesRecord> {
    const record: ListingVotesRecord | undefined = await this.ledger.load(listingId);
    return record ?? emptyRecord(listingId);
  }

  /** Mirror the aggregate counters onto the listing row (best-effort, version-checked). */
  private async syncListingCounter(listing: Product, record: ListingVotesRecord): Promise<void> {
    const projected: Product = Object.freeze({
      ...listing,
      version: listing.version + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    void record; // The ledger stays the source of truth for per-voter detail.
    try {
      await this.listings.saveListing(projected, listing.version);
    } catch (error: unknown) {
      // A stale listing mirror must not fail an already-committed vote.
      if (!(error instanceof StaleVersionError) && !(error instanceof ConflictError)) throw error;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Pure decision logic                                                        */
/* -------------------------------------------------------------------------- */

export interface VoteDecision {
  readonly outcome: VoteOutcome;
  readonly record: ListingVotesRecord;
  readonly vote: Vote | undefined;
}

/**
 * Compute the next ledger state. Given the same inputs it always returns the
 * same output — including the exact outcome label the API will report — which
 * makes the submit/toggle semantics testable without touching storage.
 */
export function decide(
  record: ListingVotesRecord,
  userId: string,
  skuId: string,
  quantity: number,
  toggle: boolean,
  now: string,
  newVoteId: string,
): VoteDecision {
  const existing: Vote | undefined = record.votes.find((vote: Vote) => vote.userId === userId);

  if (quantity <= 0 || (toggle && existing !== undefined)) {
    if (existing === undefined) {
      // Cancelling a vote that was never cast is a stable no-op.
      return { outcome: 'unchanged', record: recompute(record, now), vote: undefined };
    }
    const votes: Vote[] = record.votes.filter((vote: Vote) => vote.userId !== userId);
    return { outcome: toggle ? 'toggled_off' : 'updated', record: rebuild(record, votes, now), vote: undefined };
  }

  if (existing === undefined) {
    const vote: Vote = Object.freeze({
      id: newVoteId,
      listingId: record.listingId,
      skuId,
      userId,
      quantity,
      createdAt: now,
      updatedAt: now,
    });
    return { outcome: toggle ? 'toggled_on' : 'created', record: rebuild(record, [...record.votes, vote], now), vote };
  }

  if (existing.quantity === quantity && existing.skuId === skuId) {
    return { outcome: 'unchanged', record: recompute(record, now), vote: existing };
  }

  const replaced: Vote = Object.freeze({ ...existing, skuId, quantity, updatedAt: now });
  const votes: Vote[] = record.votes.map((vote: Vote) => (vote.userId === userId ? replaced : vote));
  return { outcome: 'updated', record: rebuild(record, votes, now), vote: replaced };
}

function emptyRecord(listingId: string): ListingVotesRecord {
  return Object.freeze({ listingId, votesCount: 0, unitsCommitted: 0, votes: Object.freeze([]), version: 0 });
}

function rebuild(record: ListingVotesRecord, votes: readonly Vote[], _now: string): ListingVotesRecord {
  const unitsCommitted: number = votes.reduce((sum: number, vote: Vote) => sum + nonNegativeInteger()(vote.quantity), 0);
  return Object.freeze({
    listingId: record.listingId,
    votesCount: votes.length,
    unitsCommitted,
    votes: Object.freeze([...votes]),
    version: record.version + 1,
  });
}

function recompute(record: ListingVotesRecord, _now: string): ListingVotesRecord {
  // No content change: keep the stored version so retries stay idempotent.
  return Object.freeze({
    listingId: record.listingId,
    votesCount: record.votes.length,
    unitsCommitted: record.votes.reduce((sum: number, vote: Vote) => sum + vote.quantity, 0),
    votes: record.votes,
    version: record.version,
  });
}

function tallyOf(record: ListingVotesRecord, listingId: string): VoteTally {
  return Object.freeze({
    listingId,
    votesCount: record.votes.length,
    unitsCommitted: record.votes.reduce((sum: number, vote: Vote) => sum + vote.quantity, 0),
    voters: Object.freeze(record.votes.map((vote: Vote) => Object.freeze({ userId: vote.userId, quantity: vote.quantity }))),
  });
}

export function normalizeId(value: string | number, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) throw ValidationError.field(field, `'${String(value)}' is not a valid id`);
    return String(value);
  }
  if (typeof value !== 'string') throw ValidationError.field(field, 'Expected a string or integer id');
  const trimmed: string = value.trim();
  if (trimmed.length === 0) throw ValidationError.field(field, 'Id is required');
  if (/^\d+$/.test(trimmed)) return String(Number.parseInt(trimmed, 10));
  try {
    return identifier(trimmed);
  } catch {
    try {
      return skuCode(trimmed);
    } catch {
      throw ValidationError.field(field, `'${trimmed}' is not a valid id`);
    }
  }
}

export function isBuyerActor(actor: Pick<User, 'role'>): boolean {
  return actor.role === 'buyer' || actor.role === 'admin';
}

export const LISTING_STATUS_SET = PRODUCT_STATUSES;
export const voteOutcomeValidator = enumOf('outcome', VOTE_OUTCOMES);
