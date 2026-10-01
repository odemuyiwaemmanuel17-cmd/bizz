/**
 * HTTP transport for the marketplace endpoints.
 *
 *   GET  /api/listings  – active listings, paginated + category filtered (public)
 *   POST /api/listings  – create a listing (protected: bearer token required)
 *   POST /api/votes     – submit or toggle a validation vote (protected)
 *
 * Zero dependencies: `node:http` server, `node:crypto` HMAC-signed bearer
 * tokens. The router (`routeRequest`) is pure with respect to Node — it takes
 * a `HttpRequest` and returns a `HttpResponse` — so every branch below is
 * unit-testable without opening a socket.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ConflictError, NotFoundError, UnauthorizedError, ValidationError, BizzError, type ErrorCode, type FieldIssue } from './errors.js';
import type { Clock } from './id.js';
import { Money, isCurrency, type Currency } from './money.js';
import {
  CatalogService,
  LISTING_MAX_PAGE_SIZE,
  resolveListingPagination,
  type CategoryRepository,
  type ListingView,
  type PagedResult,
  type ProductRepository,
} from './catalog.js';
import { ValidationService, normalizeId, type VoteLedgerRepository, type VoteListingRepository, type VoteResult } from './validation.js';
import type { Product, ProductStatus, User } from './types.js';
import { PRODUCT_STATUSES } from './types.js';

/* -------------------------------------------------------------------------- */
/* Transport-neutral request/response                                         */
/* -------------------------------------------------------------------------- */

export interface HttpRequest {
  readonly method: string;
  /** Pathname only — query parameters live in `query`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly json: unknown;
  readonly authorization: string | undefined;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AuthenticatedActor {
  readonly user: User;
  readonly tokenId: string;
}

/* -------------------------------------------------------------------------- */
/* Signed bearer tokens                                                       */
/* -------------------------------------------------------------------------- */

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_MS: number = 24 * 60 * 60 * 1000;

export interface TokenPayload {
  readonly userId: string;
  readonly role: 'buyer' | 'seller' | 'admin';
  readonly exp: number;
  readonly jti: string;
}

/** Default token lifetime (24h); consumed by auth tooling and fixtures. */
export const TOKEN_DEFAULT_TTL_MS: number = DEFAULT_TTL_MS;

export function encodeToken(payload: TokenPayload, secret: string): string {
  const body: string = base64url(JSON.stringify(payload));
  return `${TOKEN_VERSION}.${body}.${sign(`${TOKEN_VERSION}.${body}`, secret)}`;
}

export function decodeToken(token: string, secret: string): TokenPayload {
  const parts: string[] = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) throw new UnauthorizedError('Malformed bearer token');
  const expected: string = sign(`${TOKEN_VERSION}.${parts[1]}`, secret);
  if (!constantTimeEquals(expected, parts[2] ?? '')) throw new UnauthorizedError('Token signature mismatch');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as unknown;
  } catch (error: unknown) {
    throw new UnauthorizedError('Token payload is not valid JSON', { cause: error instanceof Error ? error.message : String(error) });
  }
  if (typeof payload !== 'object' || payload === null) throw new UnauthorizedError('Token payload must be an object');
  const record: Record<string, unknown> = payload as Record<string, unknown>;
  if (typeof record.userId !== 'string' || typeof record.jti !== 'string') throw new UnauthorizedError('Token is missing identity claims');
  if (record.role !== 'buyer' && record.role !== 'seller' && record.role !== 'admin') throw new UnauthorizedError('Token has an unknown role');
  if (typeof record.exp !== 'number' || !Number.isFinite(record.exp)) throw new UnauthorizedError('Token is missing an expiry claim');
  return Object.freeze({ userId: record.userId, role: record.role, exp: record.exp, jti: record.jti });
}

/** Verify signature + expiry; callers supply their own clock for determinism. */
export function verifyToken(token: string, secret: string, clock: Clock): TokenPayload {
  const payload: TokenPayload = decodeToken(token, secret);
  if (clock.now().getTime() >= payload.exp) throw new UnauthorizedError('Token has expired');
  return payload;
}

function sign(value: string, secret: string): string {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new ValidationError('JWT_SECRET must be at least 16 characters', [{ field: 'JWT_SECRET', message: 'Secret too short' }]);
  }
  return base64url(createHmac('sha256', secret).update(value).digest());
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left: Buffer = Buffer.from(a);
  const right: Buffer = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* Input schemas (built on the shared validator combinators)                  */
/* -------------------------------------------------------------------------- */

interface CreateListingBody {
  readonly sellerId?: string;
  readonly title: string;
  readonly description: string;
  readonly categoryId: string;
  readonly tags?: readonly string[];
  readonly brand?: string;
  readonly publish?: boolean;
  readonly skus: readonly {
    readonly skuCode: string;
    readonly title: string;
    readonly description?: string;
    readonly attributes?: Readonly<Record<string, string>>;
    readonly price: string | number;
    readonly currency: string;
    readonly minOrderQuantity?: number;
    readonly quantityStep?: number;
    readonly weightGrams?: number;
    readonly hsCode?: string;
    readonly imageUrl?: string;
  }[];
}

function parseCreateListing(json: unknown): CreateListingBody {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ValidationError('Request body must be a JSON object', [{ field: 'body', message: 'Expected an object' }]);
  }
  const source: Record<string, unknown> = json as Record<string, unknown>;
  const issues: FieldIssue[] = [];
  const requireText = (key: string, max: number): string => {
    const value: unknown = source[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push({ field: key, message: 'Must be a non-empty string' });
      return '';
    }
    if (value.trim().length > max) {
      issues.push({ field: key, message: `Must be at most ${String(max)} characters` });
      return '';
    }
    return value.trim();
  };

  const title: string = requireText('title', 160);
  const description: string = requireText('description', 4000);
  const categoryId: string = requireText('categoryId', 64);
  const sellerId: string | undefined =
    typeof source.sellerId === 'string' && source.sellerId.trim().length > 0 ? source.sellerId.trim() : undefined;

  let tags: readonly string[] | undefined;
  if (source.tags !== undefined) {
    if (!Array.isArray(source.tags) || !source.tags.every((tag: unknown) => typeof tag === 'string')) {
      issues.push({ field: 'tags', message: 'Must be an array of strings' });
    } else {
      tags = (source.tags as string[]).map((tag: string) => tag.trim().toLowerCase()).filter((tag: string) => tag.length > 0);
    }
  }

  let publish: boolean | undefined;
  if (source.publish !== undefined) {
    if (typeof source.publish !== 'boolean') issues.push({ field: 'publish', message: 'Must be a boolean' });
    else publish = source.publish;
  }

  const brand: string | undefined = typeof source.brand === 'string' && source.brand.trim().length > 0 ? source.brand.trim() : undefined;

  const rawSkus: unknown = source.skus;
  const skus: CreateListingBody['skus'] = [];
  if (!Array.isArray(rawSkus) || rawSkus.length === 0) {
    issues.push({ field: 'skus', message: 'At least one SKU is required' });
  } else {
    rawSkus.forEach((entry: unknown, index: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        issues.push({ field: `skus[${String(index)}]`, message: 'Must be an object' });
        return;
      }
      const sku: Record<string, unknown> = entry as Record<string, unknown>;
      const readText = (key: string): string => {
        const value: unknown = sku[key];
        if (typeof value !== 'string' || value.trim().length === 0) {
          issues.push({ field: `skus[${String(index)}.${key}]`, message: 'Must be a non-empty string' });
          return '';
        }
        return value.trim();
      };
      const rawPrice: unknown = sku.price ?? sku.unitPrice;
      const price: string = typeof rawPrice === 'number' ? rawPrice.toFixed(2) : typeof rawPrice === 'string' ? rawPrice.trim() : '';
      if (price.length === 0 || !/^\d+(\.\d{1,2})?$/.test(price)) {
        issues.push({ field: `skus[${String(index)}].price`, message: 'Must be a decimal string like "19.99"' });
      }
      const rawCurrency: unknown = sku.currency;
      const currency: string = typeof rawCurrency === 'string' ? rawCurrency.trim().toUpperCase() : '';
      if (!isCurrency(currency)) issues.push({ field: `skus[${String(index)}].currency`, message: 'Unsupported currency' });

      const optionalInt = (key: string): number | undefined => {
        const value: unknown = sku[key];
        if (value === undefined) return undefined;
        const numeric: number = typeof value === 'number' ? value : Number(typeof value === 'string' ? value.trim() : NaN);
        if (!Number.isSafeInteger(numeric) || numeric <= 0) {
          issues.push({ field: `skus[${String(index)}.${key}]`, message: 'Must be a positive whole number' });
          return undefined;
        }
        return numeric;
      };

      let attributes: Readonly<Record<string, string>> | undefined;
      if (sku.attributes !== undefined) {
        if (typeof sku.attributes !== 'object' || sku.attributes === null || Array.isArray(sku.attributes)) {
          issues.push({ field: `skus[${String(index)}].attributes`, message: 'Must be an object of strings' });
        } else {
          const map: Record<string, string> = {};
          for (const [key, value] of Object.entries(sku.attributes as Record<string, unknown>)) {
            if (typeof value !== 'string') issues.push({ field: `skus[${String(index)}].attributes.${key}`, message: 'Attribute values must be strings' });
            else map[key] = value;
          }
          attributes = map;
        }
      }

      skus.push({
        skuCode: readText('skuCode'),
        title: readText('title'),
        description: typeof sku.description === 'string' && sku.description.trim().length > 0 ? sku.description.trim() : undefined,
        attributes,
        price,
        currency,
        minOrderQuantity: optionalInt('minOrderQuantity'),
        quantityStep: optionalInt('quantityStep'),
        weightGrams: optionalInt('weightGrams'),
        hsCode: typeof sku.hsCode === 'string' && sku.hsCode.trim().length > 0 ? sku.hsCode.trim() : undefined,
        imageUrl: typeof sku.imageUrl === 'string' && sku.imageUrl.trim().length > 0 ? sku.imageUrl.trim() : undefined,
      });
    });
  }

  if (issues.length > 0) throw new ValidationError('Invalid listing payload', issues);
  return Object.freeze({ sellerId, title, description, categoryId, tags, brand, publish, skus: Object.freeze(skus) });
}

function parseVoteBody(json: unknown): { readonly listingId: string; readonly skuId?: string; readonly quantity?: number; readonly toggle?: boolean } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ValidationError('Request body must be a JSON object', [{ field: 'body', message: 'Expected an object' }]);
  }
  const source: Record<string, unknown> = json as Record<string, unknown>;
  const issues: FieldIssue[] = [];

  const rawListing: unknown = source.listingId ?? source.listing_id ?? source.listing;
  let listingId: string;
  try {
    listingId = normalizeId(rawListing as string | number, 'listingId');
  } catch (error: unknown) {
    issues.push({ field: 'listingId', message: error instanceof Error ? error.message : 'Required' });
    listingId = '';
  }

  let skuId: string | undefined;
  const rawSku: unknown = source.skuId ?? source.sku_id;
  if (rawSku !== undefined && rawSku !== null && String(rawSku).trim().length > 0) {
    try {
      skuId = normalizeId(rawSku as string | number, 'skuId');
    } catch (error: unknown) {
      issues.push({ field: 'skuId', message: error instanceof Error ? error.message : 'Invalid' });
    }
  }

  let quantity: number | undefined;
  if (source.quantity !== undefined && source.quantity !== null) {
    const numeric: number = typeof source.quantity === 'number' ? source.quantity : Number(String(source.quantity).trim());
    if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 1_000_000) {
      issues.push({ field: 'quantity', message: 'Must be a whole number between 0 and 1000000' });
    } else {
      quantity = numeric;
    }
  }

  let toggle: boolean | undefined;
  if (source.toggle !== undefined) {
    if (typeof source.toggle !== 'boolean') issues.push({ field: 'toggle', message: 'Must be a boolean' });
    else toggle = source.toggle;
  }

  if (issues.length > 0) throw new ValidationError('Invalid vote payload', issues);
  return Object.freeze({ listingId, skuId, quantity, toggle });
}

/* -------------------------------------------------------------------------- */
/* Query-string parsing for GET /api/listings                                 */
/* -------------------------------------------------------------------------- */

export interface ListingQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
  readonly categoryId: string | undefined;
  readonly categorySlug: string | undefined;
  readonly includeSubcategories: boolean;
  readonly status: ProductStatus | undefined;
  readonly sort: 'newest' | 'oldest' | 'price_asc' | 'price_desc' | 'title_asc' | 'title_desc';
  readonly query: string | undefined;
  readonly tag: string | undefined;
  readonly sellerId: string | undefined;
  readonly inStockOnly: boolean;
  readonly minPriceMinor: number | undefined;
  readonly maxPriceMinor: number | undefined;
  readonly currency: Currency | undefined;
}

const SORTS = ['newest', 'oldest', 'price_asc', 'price_desc', 'title_asc', 'title_desc'] as const;

export function parseListingQuery(query: Readonly<Record<string, string | undefined>>): ListingQuery {
  const issues: FieldIssue[] = [];

  const rawPage = query.page;
  const rawLimit = query.limit ?? query.pageSize;
  const rawOffset = query.offset;
  let page: number = 1;
  let pageSize: number = LISTING_MAX_PAGE_SIZE === 100 ? 20 : 20;
  let offset: number | undefined;
  try {
    const resolved = resolveListingPagination({
      page: rawPage === undefined ? undefined : intParam(rawPage, 'page', issues),
      pageSize: rawLimit === undefined ? undefined : intParam(rawLimit, 'limit', issues),
      limit: rawLimit === undefined ? undefined : intParam(rawLimit, 'limit', issues),
      offset: rawOffset === undefined ? undefined : intParam(rawOffset, 'offset', issues),
    });
    page = resolved.page;
    pageSize = resolved.pageSize;
    offset = rawOffset !== undefined ? resolved.offset : undefined;
  } catch (error: unknown) {
    if (error instanceof ValidationError) issues.push(...error.issues);
    else issues.push({ field: 'page', message: error instanceof Error ? error.message : 'Invalid pagination' });
  }

  const readEnum = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const raw: string | undefined = query[key];
    if (raw === undefined || raw.trim().length === 0) return undefined;
    const found: T | undefined = allowed.find((candidate: T) => candidate === raw.trim());
    if (found === undefined) {
      issues.push({ field: key, message: `Invalid value '${raw}'. Expected one of: ${allowed.join(', ')}` });
      return undefined;
    }
    return found;
  };

  const moneyParam = (key: string): number | undefined => {
    const raw: string | undefined = query[key];
    if (raw === undefined || raw.trim().length === 0) return undefined;
    if (!/^\d+(\.\d{1,2})?$/.test(raw.trim())) {
      issues.push({ field: key, message: 'Must be a decimal amount like "10" or "19.99"' });
      return undefined;
    }
    return Math.round(Number.parseFloat(raw) * 100);
  };

  const status: ProductStatus | undefined = readEnum('status', [...PRODUCT_STATUSES]);
  const sort: 'newest' | 'oldest' | 'price_asc' | 'price_desc' | 'title_asc' | 'title_desc' = readEnum('sort', SORTS) ?? 'newest';
  const currencyRaw: string | undefined = query.currency;
  let currency: Currency | undefined;
  if (currencyRaw !== undefined && currencyRaw.trim().length > 0) {
    const candidate: string = currencyRaw.trim().toUpperCase();
    if (isCurrency(candidate)) currency = candidate;
    else issues.push({ field: 'currency', message: `Unsupported currency '${currencyRaw}'` });
  }

  const boolParam = (key: string): boolean => {
    const raw: string | undefined = query[key];
    if (raw === undefined) return false;
    return raw === '1' || raw.toLowerCase() === 'true';
  };

  if (issues.length > 0) throw new ValidationError('Invalid listing query', issues);

  const textParam = (key: string): string | undefined => {
    const raw: string | undefined = query[key];
    return raw === undefined || raw.trim().length === 0 ? undefined : raw.trim();
  };

  return Object.freeze({
    page,
    pageSize,
    offset: offset ?? (page - 1) * pageSize,
    categoryId: textParam('category') ?? textParam('categoryId'),
    categorySlug: textParam('categorySlug'),
    includeSubcategories: boolParam('includeSubcategories'),
    status,
    sort,
    query: textParam('q') ?? textParam('query'),
    tag: textParam('tag'),
    sellerId: textParam('seller'),
    inStockOnly: boolParam('inStock'),
    minPriceMinor: moneyParam('minPrice'),
    maxPriceMinor: moneyParam('maxPrice'),
    currency,
  });
}

function intParam(raw: string, field: string, issues: FieldIssue[]): number | undefined {
  const numeric: number = Number(raw.trim());
  if (!Number.isSafeInteger(numeric)) {
    issues.push({ field, message: `'${raw}' is not a whole number` });
    return undefined;
  }
  return numeric;
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export interface AppDeps {
  readonly catalog: CatalogService;
  readonly votes: ValidationService;
  readonly users: { findUserById(userId: string): Promise<User | undefined> };
  readonly clock: Clock;
  readonly secret: string;
}

export interface RouteContext {
  readonly actor: User | undefined;
}

function json(data: unknown, status: number = 200): HttpResponse {
  return Object.freeze({ status, body: data });
}

function listingPayload(listing: ListingView, tallyVotesCount: number | undefined = undefined): Record<string, unknown> {
  return {
    id: listing.id,
    slug: listing.slug,
    title: listing.title,
    description: listing.description,
    categoryId: listing.categoryId,
    categoryName: listing.categoryName ?? null,
    tags: listing.tags,
    brand: listing.brand ?? null,
    sellerId: listing.sellerId,
    status: listing.status,
    publishedAt: listing.publishedAt ?? null,
    currency: listing.currency ?? null,
    priceFrom: listing.priceFromMinor ?? null,
    priceTo: listing.priceToMinor ?? null,
    availableQuantity: listing.availableQuantity,
    stockLevel: listing.stockLevel,
    ...(tallyVotesCount === undefined ? {} : { votesCount: tallyVotesCount }),
    skus: listing.skus.map((sku) => ({
      id: sku.id,
      skuCode: sku.skuCode,
      title: sku.title,
      price: sku.unitPrice.amount,
      currency: sku.currency,
      minOrderQuantity: sku.minOrderQuantity,
      quantityStep: sku.quantityStep,
    })),
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    version: listing.version,
  };
}

/** Pure dispatcher — everything below is exercised by unit tests directly. */
export async function routeRequest(request: HttpRequest, deps: AppDeps): Promise<HttpResponse> {
  const path: string = request.path.length > 1 ? request.path.replace(/\/+$/, '') : request.path;
  const method: string = request.method.toUpperCase();

  if (path === '/api/listings' && method === 'GET') return handleListListings(request, deps);
  if (path === '/api/listings' && method === 'POST') return handleCreateListing(request, deps);
  if (path === '/api/votes' && method === 'POST') return handleSubmitVote(request, deps);

  throw new NotFoundError('Route', `${method} ${request.path}`);
}

async function authenticate(request: HttpRequest, deps: AppDeps): Promise<User> {
  const header: string | undefined = request.authorization;
  if (header === undefined || header.trim().length === 0) throw new UnauthorizedError('Authorization header is required');
  const match: RegExpMatchArray | null = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) throw new UnauthorizedError('Authorization header must use the Bearer scheme');
  const payload: TokenPayload = verifyToken(match[1] ?? '', deps.secret, deps.clock);
  const user: User | undefined = await deps.users.findUserById(payload.userId);
  if (user === undefined) throw new UnauthorizedError('Account behind this token no longer exists');
  if (user.status !== 'active') throw new UnauthorizedError(`Account status '${user.status}' cannot act`);
  return user;
}

async function handleListListings(request: HttpRequest, deps: AppDeps): Promise<HttpResponse> {
  const parsed: ListingQuery = parseListingQuery(request.query);
  const result: PagedResult<ListingView> = await deps.catalog.listListings({
    // Anonymous traffic never sees anything but live inventory.
    status: parsed.status ?? 'published',
    categoryId: parsed.categoryId,
    categorySlug: parsed.categorySlug,
    includeSubcategories: parsed.includeSubcategories,
    sellerId: parsed.sellerId,
    query: parsed.query,
    tag: parsed.tag,
    minPriceMinor: parsed.minPriceMinor,
    maxPriceMinor: parsed.maxPriceMinor,
    currency: parsed.currency,
    inStockOnly: parsed.inStockOnly,
    sort: parsed.sort,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
  const items: Record<string, unknown>[] = [];
  for (const listing of result.items) {
    const tally = await deps.votes.tallyFor(listing.id);
    items.push(listingPayload(listing, tally.votesCount));
  }
  return json(Object.freeze({ data: Object.freeze(items), meta: result.page }));
}

async function handleCreateListing(request: HttpRequest, deps: AppDeps): Promise<HttpResponse> {
  const actor: User = await authenticate(request, deps);
  const body: CreateListingBody = parseCreateListing(request.json);
  const sellerId: string = body.sellerId ?? actor.id;
  if (actor.role !== 'admin' && sellerId !== actor.id) {
    throw new UnauthorizedError('You may only create listings for your own account');
  }
  const skus = body.skus.map((draft) => {
    const currency: string = draft.currency;
    if (!isCurrency(currency)) throw ValidationError.field('skus.currency', `Unsupported currency '${currency}'`);
    const price: Money = Money.fromMajor(currency, Number.parseFloat(draft.price));
    return Object.freeze({
      skuCode: draft.skuCode,
      title: draft.title,
      description: draft.description,
      attributes: draft.attributes ?? {},
      unitPrice: price,
      minOrderQuantity: draft.minOrderQuantity,
      quantityStep: draft.quantityStep,
      weightGrams: draft.weightGrams,
      hsCode: draft.hsCode,
      imageUrl: draft.imageUrl,
    });
  });

  let product: Product;
  try {
    product = await deps.catalog.createProduct({
      actor,
      sellerId,
      title: body.title,
      description: body.description,
      categoryId: body.categoryId,
      tags: body.tags,
      brand: body.brand,
      publish: body.publish ?? true,
      skus,
    });
  } catch (error: unknown) {
    if (error instanceof ConflictError && /slug/i.test(error.message)) {
      return json(
        {
          error: { code: 'CONFLICT', message: 'A listing with a similar title already exists — pick another name', details: error.details },
        },
        409,
      );
    }
    throw error;
  }

  const view: ListingView = await deps.catalog.getListing(product.id);
  return json(Object.freeze({ data: listingPayload(view, 0) }), 201);
}

async function handleSubmitVote(request: HttpRequest, deps: AppDeps): Promise<HttpResponse> {
  const actor: User = await authenticate(request, deps);
  const body = parseVoteBody(request.json);
  const result: VoteResult = await deps.votes.submit({
    actor,
    listingId: body.listingId,
    skuId: body.skuId,
    quantity: body.quantity,
    toggle: body.toggle,
  });
  const status: number = result.outcome === 'created' || result.outcome === 'toggled_on' ? 201 : 200;
  return json(
    Object.freeze({
      data: Object.freeze({
        outcome: result.outcome,
        vote: result.vote ?? null,
        listingId: result.tally.listingId,
        votesCount: result.tally.votesCount,
        unitsCommitted: result.tally.unitsCommitted,
      }),
    }),
    status,
  );
}

/* -------------------------------------------------------------------------- */
/* Error -> HTTP mapping                                                      */
/* -------------------------------------------------------------------------- */

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  INSUFFICIENT_STOCK: 409,
  INVALID_STATE: 409,
  UNAUTHORIZED: 401,
  DUPLICATE_REQUEST: 409,
  STALE_VERSION: 409,
  INTERNAL: 500,
};

export function errorToResponse(error: unknown): HttpResponse {
  if (error instanceof BizzError) {
    const status: number = STATUS_BY_CODE[error.code] ?? 400;
    return json(
      Object.freeze({
        error: Object.freeze({
          code: error.code,
          message: error.message,
          ...(error.issues.length > 0 ? { issues: error.issues } : {}),
          ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
        }),
      }),
      status,
    );
  }
  if (error instanceof SyntaxError) {
    return json(Object.freeze({ error: Object.freeze({ code: 'VALIDATION', message: 'Request body is not valid JSON' }) }), 400);
  }
  return json(Object.freeze({ error: Object.freeze({ code: 'INTERNAL', message: 'Unexpected failure' }) }), 500);
}

/* -------------------------------------------------------------------------- */
/* node:http adapter                                                          */
/* -------------------------------------------------------------------------- */

export interface ReadBodyOptions {
  readonly maxBytes?: number;
}

/** Collect a request body with a hard size cap; malformed JSON surfaces as SyntaxError. */
export async function readJsonBody(message: IncomingMessage, options: ReadBodyOptions = {}): Promise<unknown> {
  const maxBytes: number = options.maxBytes ?? 64 * 1024;
  const chunks: Buffer[] = [];
  let total: number = 0;
  await new Promise<void>((resolve, reject) => {
    message.on('data', (chunk: Buffer | string) => {
      const buffer: Buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buffer.length;
      if (total > maxBytes) {
        reject(new ValidationError(`Request body exceeds ${String(maxBytes)} bytes`, [{ field: 'body', message: 'Payload too large' }]));
        message.destroy();
        return;
      }
      chunks.push(buffer);
    });
    message.on('end', () => resolve());
    message.on('error', (error: Error) => reject(error));
  });
  const text: string = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return {};
  return JSON.parse(text) as unknown;
}

export function toHttpRequest(message: IncomingMessage, json: unknown): HttpRequest {
  const url: URL = new URL(message.url ?? '/', 'http://localhost');
  const query: Record<string, string | undefined> = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return Object.freeze({
    method: message.method ?? 'GET',
    path: url.pathname,
    query: Object.freeze(query),
    json,
    authorization: typeof message.headers.authorization === 'string' ? message.headers.authorization : undefined,
  });
}

export function writeResponse(response: ServerResponse, result: HttpResponse): void {
  const payload: string = JSON.stringify(result.body ?? null);
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    ...(result.headers ?? {}),
  });
  response.end(payload);
}

export interface ServerConfig extends AppDeps {
  readonly port?: number;
  readonly host?: string;
}

/** Boots the API; rejects (instead of crashing) when the port cannot be bound. */
export function startServer(config: ServerConfig): Promise<{ readonly server: ReturnType<typeof createServer>; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((message: IncomingMessage, response: ServerResponse) => {
      void (async () => {
        try {
          const json: unknown = await readJsonBody(message);
          const request: HttpRequest = toHttpRequest(message, json);
          const result: HttpResponse = await routeRequest(request, config);
          writeResponse(response, result);
        } catch (error: unknown) {
          writeResponse(response, errorToResponse(error));
        }
      })();
    });
    server.once('error', reject);
    server.listen(config.port ?? 3000, config.host ?? '127.0.0.1', () => {
      const address: AddressInfo | string | null = server.address();
      const port: number = typeof address === 'object' && address !== null ? address.port : (config.port ?? 3000);
      resolve(Object.freeze({ server, port }));
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Composition root                                                           */
/* -------------------------------------------------------------------------- */

export interface WireOptions {
  readonly products: ProductRepository;
  readonly categories?: CategoryRepository;
  readonly listings: VoteListingRepository;
  readonly ledger: VoteLedgerRepository;
  readonly users: { findUserById(userId: string): Promise<User | undefined> };
  readonly clock: Clock;
  readonly secret: string;
}

export function createApp(deps: WireOptions): AppDeps {
  const catalog: CatalogService = new CatalogService({ products: deps.products, categories: deps.categories, clock: deps.clock });
  const votes: ValidationService = new ValidationService({ listings: deps.listings, ledger: deps.ledger, clock: deps.clock });
  return Object.freeze({ catalog, votes, users: deps.users, clock: deps.clock, secret: deps.secret });
}
