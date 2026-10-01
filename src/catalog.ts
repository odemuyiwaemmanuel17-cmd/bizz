/**
 * Catalog service: products, SKUs and search.
 *
 * Slug uniqueness is enforced at the repository boundary (with an in-memory
 * fallback index for local runs), prices are always `Money`, and every mutation
 * is ownership-checked through RBAC policies before touching storage.
 */

import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import type { Clock } from './id.js';
import { SequentialIdGenerator } from './id.js';
import { Money } from './money.js';
import type { Currency } from './money.js';
import { assertActiveAccount, assertCanManageSku, assertPermission, assertPolicy, productOwnershipPolicy } from './rbac.js';
import { integer, nonNegativeInteger, identifier, nonEmptyText, positiveInteger, quantityRespecting, recordOfValues, shortText, slug as slugValidator, skuCode as skuCodeValidator, string, enumOf } from './schema.js';
import { PRODUCT_STATUSES, STOCK_LEVELS, type Category, type Product, type ProductStatus, type Sku, type StockLevel, type User } from './types.js';

export interface ProductRepository {
  findProduct(productId: string): Promise<Product | undefined>;
  findSku(skuId: string): Promise<Sku | undefined>;
  findSkusByProduct(productId: string): Promise<readonly Sku[]>;
  findBySlug(slug: string): Promise<Product | undefined>;
  saveProduct(product: Product, expectedVersion: number): Promise<Product>;
  saveSku(sku: Sku, expectedVersion: number): Promise<Sku>;
  allProducts(): Promise<readonly Product[]>;
}

export interface CategoryRepository {
  find(categoryId: string): Promise<Category | undefined>;
  all(): Promise<readonly Category[]>;
}

export interface CreateProductInput {
  readonly actor: User;
  readonly sellerId: string;
  readonly title: string;
  readonly description: string;
  readonly categoryId: string;
  readonly tags?: readonly string[];
  readonly brand?: string;
  readonly skus: readonly CreateSkuInput[];
  readonly publish?: boolean;
}

export interface CreateSkuInput {
  readonly skuCode: string;
  readonly title: string;
  readonly description?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly unitPrice: Money;
  readonly compareAtPrice?: Money;
  readonly minOrderQuantity?: number;
  readonly quantityStep?: number;
  readonly weightGrams?: number;
  readonly hsCode?: string;
  readonly imageUrl?: string;
}

export interface UpdateProductInput {
  readonly actor: User;
  readonly productId: string;
  readonly patch: Partial<Pick<Product, 'title' | 'description' | 'tags' | 'brand' | 'slug' | 'categoryId'>>;
  readonly expectedVersion?: number;
}

export interface SearchFilters {
  readonly query?: string;
  readonly categoryId?: string;
  readonly sellerId?: string;
  readonly status?: ProductStatus;
  readonly minPrice?: Money;
  readonly maxPrice?: Money;
  readonly currency?: string;
  readonly inStockOnly?: boolean;
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface SearchResult {
  readonly product: Product;
  readonly matchedSkus: readonly Sku[];
  readonly priceFrom: Money | undefined;
  readonly priceTo: Money | undefined;
  readonly totalAvailable: number;
  readonly score: number;
}

export interface ListingView {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly categoryId: string;
  readonly categoryName: string | undefined;
  readonly tags: readonly string[];
  readonly brand: string | undefined;
  readonly sellerId: string;
  readonly status: ProductStatus;
  readonly publishedAt: string | undefined;
  readonly priceFromMinor: number | undefined;
  readonly priceToMinor: number | undefined;
  readonly currency: Currency | undefined;
  readonly availableQuantity: number;
  readonly stockLevel: StockLevel;
  readonly skus: readonly Sku[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ListListingsFilters {
  /** Defaults to `published` — the public market only ever sees live listings. */
  readonly status?: ProductStatus;
  readonly categoryId?: string;
  readonly categorySlug?: string;
  readonly includeSubcategories?: boolean;
  readonly sellerId?: string;
  readonly query?: string;
  readonly tag?: string;
  readonly minPriceMinor?: number;
  readonly maxPriceMinor?: number;
  readonly currency?: Currency;
  readonly inStockOnly?: boolean;
  readonly sort?: 'newest' | 'oldest' | 'price_asc' | 'price_desc' | 'title_asc' | 'title_desc';
  readonly limit?: number;
  readonly offset?: number;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PageMeta {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
}

export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly page: PageMeta;
}

export const LISTING_DEFAULT_PAGE_SIZE = 20;
export const LISTING_MAX_PAGE_SIZE = 100;

const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export function normalizeSlug(input: string): string {
  const base: string = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (base.length < 3) throw ValidationError.field('slug', `'${input}' cannot be turned into a URL slug`);
  return slugValidator(base);
}

/** In-memory catalog store; mirrors the version/slug semantics of SQL. */
export class InMemoryProductRepository implements ProductRepository {
  private readonly products: Map<string, Product> = new Map();
  private readonly skus: Map<string, Sku> = new Map();
  private readonly slugs: Map<string, string> = new Map();

  public async findProduct(productId: string): Promise<Product | undefined> {
    return this.products.get(productId);
  }

  public async findSku(skuId: string): Promise<Sku | undefined> {
    return this.skus.get(skuId);
  }

  public async findSkusByProduct(productId: string): Promise<readonly Sku[]> {
    return Object.freeze([...this.skus.values()].filter((sku: Sku) => sku.productId === productId));
  }

  public async findBySlug(candidate: string): Promise<Product | undefined> {
    const id: string | undefined = this.slugs.get(candidate);
    return id === undefined ? undefined : this.products.get(id);
  }

  public async saveProduct(product: Product, expectedVersion: number): Promise<Product> {
    const current: Product | undefined = this.products.get(product.id);
    const slugOwner: string | undefined = this.slugs.get(product.slug);
    if (slugOwner !== undefined && slugOwner !== product.id) {
      throw new ConflictError(`Slug '${product.slug}' is already taken`, { slug: product.slug });
    }
    if (current === undefined && expectedVersion !== 0) {
      throw new ConflictError(`Product '${product.id}' does not exist`, { productId: product.id });
    }
    if (current !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(`Product '${product.id}' changed concurrently`, {
        productId: product.id,
        expectedVersion,
        actualVersion: current.version,
      });
    }
    if (current !== undefined && current.slug !== product.slug) this.slugs.delete(current.slug);
    const frozen: Product = Object.freeze({ ...product, skus: Object.freeze([...product.skus]) });
    this.products.set(frozen.id, frozen);
    this.slugs.set(frozen.slug, frozen.id);
    for (const sku of frozen.skus) this.skus.set(sku.id, sku);
    return frozen;
  }

  public async saveSku(sku: Sku, expectedVersion: number): Promise<Sku> {
    const current: Sku | undefined = this.skus.get(sku.id);
    if (current !== undefined && current.version !== expectedVersion) {
      throw new ConflictError(`SKU '${sku.id}' changed concurrently`, {
        skuId: sku.id,
        expectedVersion,
        actualVersion: current.version,
      });
    }
    const duplicate: Sku | undefined = [...this.skus.values()].find(
      (candidate: Sku) => candidate.productId === sku.productId && candidate.skuCode === sku.skuCode && candidate.id !== sku.id,
    );
    if (duplicate !== undefined) {
      throw new ConflictError(`SKU code '${sku.skuCode}' already exists on this product`, { skuCode: sku.skuCode });
    }
    const frozen: Sku = Object.freeze({ ...sku });
    this.skus.set(frozen.id, frozen);
    const parent: Product | undefined = this.products.get(frozen.productId);
    if (parent !== undefined) {
      const skus: Sku[] = parent.skus.filter((candidate: Sku) => candidate.id !== frozen.id);
      skus.push(frozen);
      // Keep the aggregate in sync without bumping the product version.
      this.products.set(parent.id, Object.freeze({ ...parent, skus: Object.freeze(skus) }));
    }
    return frozen;
  }

  public async allProducts(): Promise<readonly Product[]> {
    return Object.freeze([...this.products.values()]);
  }
}

export class StaticCategoryRepository implements CategoryRepository {
  public constructor(private readonly categories: readonly Category[] = []) {}

  public async find(categoryId: string): Promise<Category | undefined> {
    return this.categories.find((category: Category) => category.id === categoryId);
  }

  public async all(): Promise<readonly Category[]> {
    return Object.freeze([...this.categories]);
  }
}

export interface StockProbe {
  available(skuId: string): Promise<number>;
}

export interface CatalogServiceOptions {
  readonly products: ProductRepository;
  readonly categories?: CategoryRepository;
  readonly clock: Clock;
  readonly idGenerator?: SequentialIdGenerator;
  readonly stock?: StockProbe;
}

export class CatalogService {
  private readonly products: ProductRepository;
  private readonly categories: CategoryRepository | undefined;
  private readonly clock: Clock;
  private readonly ids: SequentialIdGenerator;
  private readonly stock: StockProbe | undefined;

  public constructor(options: CatalogServiceOptions) {
    if (options.products === undefined) throw ValidationError.field('products', 'A product repository is required');
    if (options.clock === undefined) throw ValidationError.field('clock', 'A clock is required');
    this.products = options.products;
    this.categories = options.categories;
    this.clock = options.clock;
    this.ids = options.idGenerator ?? new SequentialIdGenerator('catalog');
    this.stock = options.stock;
  }

  /* ------------------------------- products ------------------------------ */

  public async createProduct(input: CreateProductInput): Promise<Product> {
    assertActiveAccount(input.actor);
    assertPermission(input.actor, 'product.create', 'catalog');
    if (input.actor.role !== 'admin' && input.actor.id !== input.sellerId) {
      throw new ConflictError('Sellers can only create listings for themselves', { sellerId: input.sellerId });
    }
    if (!Array.isArray(input.skus) || input.skus.length === 0) {
      throw ValidationError.field('skus', 'A product needs at least one SKU');
    }

    const title: string = shortText(input.title);
    const description: string = nonEmptyText(input.description);
    const categoryId: string = identifier(input.categoryId);
    await this.assertCategoryExists(categoryId);

    const resolvedSlug: string = normalizeSlug(title);
    const clash: Product | undefined = await this.products.findBySlug(resolvedSlug);
    if (clash !== undefined) throw new ConflictError(`Slug '${resolvedSlug}' is already in use`, { slug: resolvedSlug });

    const now: string = this.clock.now().toISOString();
    const productId: string = this.ids.next('prd');
    const status: ProductStatus = input.publish === true ? 'published' : 'draft';

    const skus: Sku[] = [];
    for (const draft of input.skus) {
      skus.push(this.buildSku({ productId, sellerId: input.sellerId, status, now }, draft));
    }

    const product: Product = Object.freeze({
      id: productId,
      sellerId: input.sellerId,
      title,
      description,
      slug: resolvedSlug,
      categoryId,
      tags: normalizeTags(input.tags),
      brand: input.brand === undefined ? undefined : shortText(input.brand),
      skus: Object.freeze(skus),
      status,
      publishedAt: status === 'published' ? now : undefined,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    return await this.products.saveProduct(product, 0);
  }

  public async updateProduct(input: UpdateProductInput): Promise<Product> {
    const product: Product = await this.getProduct(input.productId);
    assertPolicy(input.actor, { sellerId: product.sellerId }, productOwnershipPolicy);
    this.checkVersion(product.version, input.expectedVersion, 'Product', product.id);

    const patch: Partial<Pick<Product, 'title' | 'description' | 'tags' | 'brand' | 'slug' | 'categoryId'>> = {};
    if (input.patch.title !== undefined) patch.title = shortText(input.patch.title);
    if (input.patch.description !== undefined) patch.description = nonEmptyText(input.patch.description);
    if (input.patch.brand !== undefined) patch.brand = shortText(input.patch.brand);
    if (input.patch.tags !== undefined) patch.tags = normalizeTags(input.patch.tags);
    if (input.patch.categoryId !== undefined) {
      await this.assertCategoryExists(identifier(input.patch.categoryId));
      patch.categoryId = identifier(input.patch.categoryId);
    }
    if (input.patch.slug !== undefined) {
      const nextSlug: string = normalizeSlug(input.patch.slug);
      const clash: Product | undefined = await this.products.findBySlug(nextSlug);
      if (clash !== undefined && clash.id !== product.id) {
        throw new ConflictError(`Slug '${nextSlug}' is already in use`, { slug: nextSlug });
      }
      patch.slug = nextSlug;
    }

    return await this.products.saveProduct(
      Object.freeze({ ...product, ...patch, version: product.version + 1, updatedAt: this.clock.now().toISOString() }),
      product.version,
    );
  }

  public async setProductStatus(input: {
    readonly actor: User;
    readonly productId: string;
    readonly status: ProductStatus;
    readonly expectedVersion?: number;
  }): Promise<Product> {
    const status: ProductStatus = enumOf('status', PRODUCT_STATUSES)(input.status);
    const product: Product = await this.getProduct(input.productId);
    assertPermission(input.actor, 'catalog.publish', 'catalog publishing');
    assertPolicy(input.actor, { sellerId: product.sellerId }, productOwnershipPolicy);
    this.checkVersion(product.version, input.expectedVersion, 'Product', product.id);

    if (status === 'published' && product.skus.length === 0) {
      throw new ConflictError('Cannot publish a product without SKUs', { productId: product.id });
    }
    const now: string = this.clock.now().toISOString();
    const skus: Sku[] = product.skus.map((sku: Sku) => Object.freeze({ ...sku, status, version: sku.version + 1, updatedAt: now }));
    for (const sku of skus) await this.products.saveSku(sku, sku.version - 1);

    return await this.products.saveProduct(
      Object.freeze({
        ...product,
        skus: Object.freeze(skus),
        status,
        publishedAt: status === 'published' ? (product.publishedAt ?? now) : product.publishedAt,
        version: product.version + 1,
        updatedAt: now,
      }),
      product.version,
    );
  }

  public async getProduct(productId: string): Promise<Product> {
    if (typeof productId !== 'string' || productId.trim().length === 0) {
      throw ValidationError.field('productId', 'Product id is required');
    }
    const product: Product | undefined = await this.products.findProduct(productId);
    if (product === undefined) throw new NotFoundError('Product', productId);
    return product;
  }

  public async getSku(skuId: string): Promise<Sku | undefined> {
    if (typeof skuId !== 'string' || skuId.trim().length === 0) return undefined;
    return await this.products.findSku(skuId);
  }

  /** Adapter consumed by the cart/order services. */
  public catalogPort(): { getSku(skuId: string): Promise<Sku | undefined> } {
    return { getSku: (skuId: string) => this.getSku(skuId) };
  }

  /* --------------------------------- skus -------------------------------- */

  public async addSku(input: {
    readonly actor: User;
    readonly productId: string;
    readonly sku: CreateSkuInput;
    readonly expectedVersion?: number;
  }): Promise<Sku> {
    const product: Product = await this.getProduct(input.productId);
    assertPermission(input.actor, 'sku.manage.own', 'SKU management');
    assertPolicy(input.actor, { sellerId: product.sellerId }, productOwnershipPolicy);
    this.checkVersion(product.version, input.expectedVersion, 'Product', product.id);

    const now: string = this.clock.now().toISOString();
    const sku: Sku = this.buildSku({ productId: product.id, sellerId: product.sellerId, status: product.status, now }, input.sku);
    return await this.products.saveSku(sku, 0);
  }

  public async updateSkuPrice(input: {
    readonly actor: User;
    readonly skuId: string;
    readonly unitPrice: Money;
    readonly compareAtPrice?: Money;
    readonly expectedVersion?: number;
  }): Promise<Sku> {
    const sku: Sku = await this.requireSku(input.skuId);
    assertCanManageSku(input.actor, sku);
    this.checkVersion(sku.version, input.expectedVersion, 'Sku', sku.id);
    if (!input.unitPrice.isPositive) throw ValidationError.field('unitPrice', 'Price must be greater than zero');
    if (input.compareAtPrice !== undefined) {
      if (input.compareAtPrice.currency !== input.unitPrice.currency) {
        throw ValidationError.field('compareAtPrice', 'Compare-at price must use the same currency');
      }
      if (input.compareAtPrice.lessThan(input.unitPrice)) {
        throw ValidationError.field('compareAtPrice', 'Compare-at price must not be below the selling price');
      }
    }
    const updated: Sku = Object.freeze({
      ...sku,
      unitPrice: input.unitPrice,
      compareAtPrice: input.compareAtPrice,
      currency: input.unitPrice.currency,
      version: sku.version + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    return await this.products.saveSku(updated, sku.version);
  }

  public async setSkuQuantityRules(input: {
    readonly actor: User;
    readonly skuId: string;
    readonly minOrderQuantity: number;
    readonly quantityStep: number;
    readonly expectedVersion?: number;
  }): Promise<Sku> {
    const sku: Sku = await this.requireSku(input.skuId);
    assertCanManageSku(input.actor, sku);
    this.checkVersion(sku.version, input.expectedVersion, 'Sku', sku.id);
    const minOrderQuantity: number = positiveInteger()(input.minOrderQuantity);
    const quantityStep: number = positiveInteger()(input.quantityStep);
    if (minOrderQuantity % quantityStep !== 0) {
      throw ValidationError.field('quantityStep', `Minimum order quantity (${String(minOrderQuantity)}) must be a multiple of the step (${String(quantityStep)})`);
    }
    const updated: Sku = Object.freeze({
      ...sku,
      minOrderQuantity,
      quantityStep,
      version: sku.version + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    return await this.products.saveSku(updated, sku.version);
  }

  public async validatePurchaseQuantity(skuId: string, quantity: number): Promise<number> {
    const sku: Sku = await this.requireSku(skuId);
    return quantityRespecting(sku.minOrderQuantity, sku.quantityStep)(quantity);
  }

  /* ------------------------------- listings ------------------------------ */

  /**
   * `GET /api/listings` backing service: active listings, paginated and
   * category-filtered. The default status is `published`, so drafts/archived
   * rows never leak to anonymous callers; sellers/admins may pass an explicit
   * `status` (or `'all'` from the HTTP layer) to see their own pipeline.
   */
  public async listListings(filters: ListListingsFilters = {}): Promise<PagedResult<ListingView>> {
    const statusFilter: ProductStatus | 'all' = filters.status ?? 'published';
    const pagination = resolveListingPagination(filters);

    let candidates: readonly Product[] = await this.products.allProducts();
    if (statusFilter !== 'all') {
      candidates = candidates.filter((product: Product) => product.status === statusFilter);
    }
    if (filters.sellerId !== undefined) {
      candidates = candidates.filter((product: Product) => product.sellerId === filters.sellerId);
    }

    const allowedCategoryIds: ReadonlySet<string> | undefined = await this.resolveCategoryScope(filters);
    if (allowedCategoryIds !== undefined) {
      candidates = candidates.filter((product: Product) => allowedCategoryIds.has(product.categoryId));
    }

    const term: string = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
    if (term.length > 0) {
      candidates = candidates.filter((product: Product) => matchesTerm(term, product, undefined));
    }

    if (typeof filters.tag === 'string' && filters.tag.trim().length > 0) {
      const tag: string = filters.tag.trim().toLowerCase();
      candidates = candidates.filter((product: Product) => product.tags.includes(tag));
    }

    const priced: ReadonlyArray<{ readonly product: Product; readonly skus: readonly Sku[] }> = candidates.map(
      (product: Product) => {
        const skus: Sku[] = product.skus.filter((sku: Sku) => sku.status === (statusFilter === 'all' ? sku.status : statusFilter));
        const visibleSkus: Sku[] = skus.length > 0 ? skus : [...product.skus];
        return Object.freeze({ product, skus: Object.freeze(visibleSkus) });
      },
    );

    const withStock: ListingView[] = [];
    const categoryNames: ReadonlyMap<string, string> = await this.categoryNamesById();
    for (const entry of priced) {
      let available: number = 0;
      if (this.stock !== undefined) {
        for (const sku of entry.skus) {
          try {
            available += Math.max(0, await this.stock.available(sku.id));
          } catch {
            // A stock outage degrades availability to zero rather than 500-ing the feed.
            available += 0;
          }
        }
      } else {
        available = entry.product.skus.length > 0 ? Number.MAX_SAFE_INTEGER : 0;
      }
      if (filters.inStockOnly === true && available <= 0) continue;

      const prices: Money[] = entry.skus.map((sku: Sku) => sku.unitPrice);
      const currency: Currency | undefined = prices[0]?.currency;
      const priceFrom: Money | undefined = minMoney(prices);
      const priceTo: Money | undefined = maxMoney(prices);
      if (filters.currency !== undefined && currency !== filters.currency) continue;
      if (filters.minPriceMinor !== undefined && (priceFrom === undefined || priceFrom.amount < filters.minPriceMinor)) continue;
      if (filters.maxPriceMinor !== undefined && (priceTo === undefined || priceTo.amount > filters.maxPriceMinor)) continue;

      withStock.push(
        toListingView(entry.product, entry.skus, available, priceFrom, priceTo, currency, categoryNames, this.stock !== undefined),
      );
    }

    withStock.sort(compareListings(filters.sort ?? 'newest'));

    const total: number = withStock.length;
    const start: number = pagination.offset;
    const items: readonly ListingView[] = Object.freeze(withStock.slice(start, start + pagination.pageSize));
    const page: PageMeta = buildPageMeta(total, pagination.page, pagination.pageSize);
    return Object.freeze({ items, page });
  }

  /** Shared JSON shape for `GET /api/listings/:id` and creation responses. */
  public async getListing(productId: string): Promise<ListingView> {
    const product: Product = await this.getProduct(productId);
    let available: number = 0;
    if (this.stock !== undefined) {
      for (const sku of product.skus) {
        try {
          available += Math.max(0, await this.stock.available(sku.id));
        } catch {
          available += 0;
        }
      }
    }
    const prices: Money[] = product.skus.map((sku: Sku) => sku.unitPrice);
    const categoryNames: ReadonlyMap<string, string> = await this.categoryNamesById();
    return toListingView(
      product,
      product.skus,
      available,
      minMoney(prices),
      maxMoney(prices),
      prices[0]?.currency,
      categoryNames,
      this.stock !== undefined,
    );
  }

  private categoryNames: Map<string, string> | undefined;

  /** Lazily memoised id -> name map so listing payloads can show labels. */
  private async categoryNamesById(): Promise<ReadonlyMap<string, string>> {
    if (this.categoryNames !== undefined) return this.categoryNames;
    const map: Map<string, string> = new Map<string, string>();
    if (this.categories !== undefined) {
      try {
        for (const category of await this.categories.all()) map.set(category.id, category.name);
      } catch {
        // Name decoration is best-effort; ids always ship.
      }
    }
    this.categoryNames = map;
    return map;
  }

  /** Resolve `categoryId`/`categorySlug` (optionally incl. descendants) into a filter set. */
  private async resolveCategoryScope(filters: ListListingsFilters): Promise<ReadonlySet<string> | undefined> {
    let rootId: string | undefined = filters.categoryId;
    if (rootId === undefined && typeof filters.categorySlug === 'string' && filters.categorySlug.trim().length > 0) {
      const wanted: string = filters.categorySlug.trim().toLowerCase();
      if (this.categories === undefined) throw ValidationError.field('categorySlug', 'Category lookups are unavailable');
      const all: readonly Category[] = await this.categories.all();
      const match: Category | undefined = all.find((category: Category) => category.slug === wanted);
      if (match === undefined) throw new NotFoundError('Category', filters.categorySlug);
      rootId = match.id;
    }
    if (rootId === undefined) return undefined;
    if (filters.includeSubcategories !== true) return new Set<string>([rootId]);
    if (this.categories === undefined) return new Set<string>([rootId]);
    const all: readonly Category[] = await this.categories.all();
    const scope: Set<string> = new Set<string>([rootId]);
    let grew: boolean = true;
    while (grew) {
      grew = false;
      for (const category of all) {
        if (category.parentId !== undefined && scope.has(category.parentId) && !scope.has(category.id)) {
          scope.add(category.id);
          grew = true;
        }
      }
    }
    return scope;
  }

  /* -------------------------------- search ------------------------------- */

  public async search(filters: SearchFilters): Promise<readonly SearchResult[]> {
    const limit: number = Math.min(positiveInteger()(filters.limit ?? 20), 100);
    const offset: number = filters.offset === undefined ? 0 : positiveInteger(0)(filters.offset);
    const term: string = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
    const products: readonly Product[] = await this.products.allProducts();

    const results: SearchResult[] = [];
    for (const product of products) {
      if (product.status !== 'published' && filters.status === undefined) continue;
      if (filters.status !== undefined && product.status !== filters.status) continue;
      if (filters.categoryId !== undefined && product.categoryId !== filters.categoryId) continue;
      if (filters.sellerId !== undefined && product.sellerId !== filters.sellerId) continue;
      if (filters.tags !== undefined && filters.tags.length > 0) {
        const wanted: readonly string[] = normalizeTags(filters.tags);
        if (!wanted.every((tag: string) => product.tags.includes(tag))) continue;
      }

      let matched: Sku[] = product.skus.filter((sku: Sku) => sku.status === 'published');
      if (term.length > 0) {
        matched = matched.filter((sku: Sku) => matchesTerm(term, product, sku));
        if (matched.length === 0 && matchesTerm(term, product, undefined)) matched = [...product.skus];
      }
      if (filters.currency !== undefined) {
        matched = matched.filter((sku: Sku) => sku.currency === filters.currency);
      }
      if (filters.minPrice !== undefined) matched = matched.filter((sku: Sku) => sku.unitPrice.atLeast(filters.minPrice as Money));
      if (filters.maxPrice !== undefined) matched = matched.filter((sku: Sku) => sku.unitPrice.atMost(filters.maxPrice as Money));
      if (matched.length === 0) continue;

      if (filters.inStockOnly === true && this.stock !== undefined) {
        const withStock: Sku[] = [];
        for (const sku of matched) {
          try {
            if ((await this.stock.available(sku.id)) > 0) withStock.push(sku);
          } catch {
            // A stock outage must not crash search; treat the SKU as unavailable.
          }
        }
        matched = withStock;
        if (matched.length === 0) continue;
      }

      let totalAvailable: number = 0;
      if (this.stock !== undefined) {
        for (const sku of matched) {
          try {
            totalAvailable += await this.stock.available(sku.id);
          } catch {
            totalAvailable += 0;
          }
        }
      }

      const prices: Money[] = matched.map((sku: Sku) => sku.unitPrice);
      results.push({
        product: Object.freeze({ ...product, skus: Object.freeze(matched) }),
        matchedSkus: Object.freeze(matched),
        priceFrom: minMoney(prices),
        priceTo: maxMoney(prices),
        totalAvailable,
        score: relevanceScore(term, product, matched.length),
      });
    }

    results.sort((a: SearchResult, b: SearchResult) => b.score - a.score || a.product.title.localeCompare(b.product.title));
    return Object.freeze(results.slice(offset, offset + limit));
  }

  /* ------------------------------- internals ----------------------------- */

  private buildSku(
    context: { readonly productId: string; readonly sellerId: string; readonly status: ProductStatus; readonly now: string },
    draft: CreateSkuInput,
  ): Sku {
    const unitPrice: Money = requireMoney(draft.unitPrice);
    if (!unitPrice.isPositive) throw ValidationError.field('unitPrice', 'Unit price must be greater than zero');
    if (draft.compareAtPrice !== undefined) {
      const compare: Money = requireMoney(draft.compareAtPrice);
      if (compare.currency !== unitPrice.currency) {
        throw ValidationError.field('compareAtPrice', 'Compare-at price must use the same currency');
      }
    }
    const minOrderQuantity: number = positiveInteger()(draft.minOrderQuantity ?? 1);
    const quantityStep: number = positiveInteger()(draft.quantityStep ?? 1);
    if (minOrderQuantity % quantityStep !== 0) {
      throw ValidationError.field('quantityStep', 'Minimum order quantity must be a multiple of the quantity step');
    }
    return Object.freeze({
      id: this.ids.next('sku'),
      productId: context.productId,
      sellerId: context.sellerId,
      skuCode: skuCodeValidator(draft.skuCode),
      title: shortText(draft.title),
      description: draft.description === undefined ? undefined : nonEmptyText(draft.description),
      attributes: recordOfValues(string({ minLength: 1, maxLength: 120 }))(draft.attributes ?? {}),
      unitPrice,
      compareAtPrice: draft.compareAtPrice,
      minOrderQuantity,
      quantityStep,
      currency: unitPrice.currency,
      weightGrams: draft.weightGrams === undefined ? undefined : positiveInteger()(draft.weightGrams),
      hsCode: draft.hsCode,
      imageUrl: draft.imageUrl,
      status: context.status,
      createdAt: context.now,
      updatedAt: context.now,
      version: 1,
    });
  }

  private async requireSku(skuId: string): Promise<Sku> {
    const sku: Sku | undefined = await this.getSku(skuId);
    if (sku === undefined) throw new NotFoundError('Sku', skuId);
    return sku;
  }

  private checkVersion(actual: number, expected: number | undefined, entity: string, id: string): void {
    if (expected !== undefined && expected !== actual) {
      throw new ConflictError(`${entity} '${id}' changed; reload before retrying`, {
        expectedVersion: expected,
        actualVersion: actual,
      });
    }
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    if (this.categories === undefined) return;
    const category: Category | undefined = await this.categories.find(categoryId);
    if (category === undefined) throw new NotFoundError('Category', categoryId);
  }
}

/** Pure projection of a Product aggregate into the public listing payload. */
export function toListingView(
  product: Product,
  skus: readonly Sku[],
  available: number,
  priceFrom: Money | undefined,
  priceTo: Money | undefined,
  currency: Currency | undefined,
  categoryNames: ReadonlyMap<string, string>,
  stockKnown: boolean,
): ListingView {
  return Object.freeze({
    id: product.id,
    slug: product.slug,
    title: product.title,
    description: product.description,
    categoryId: product.categoryId,
    categoryName: categoryNames.get(product.categoryId),
    tags: product.tags,
    brand: product.brand,
    sellerId: product.sellerId,
    status: product.status,
    publishedAt: product.publishedAt,
    priceFromMinor: priceFrom?.amount,
    priceToMinor: priceTo?.amount,
    currency,
    availableQuantity: stockKnown ? available : 0,
    stockLevel: listingStockLevel(available, skus, stockKnown),
    skus: Object.freeze([...skus]),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    version: product.version,
  });
}

/** Bucket derived from availability; without a stock probe we cannot claim a level. */
export function listingStockLevel(available: number, skus: readonly Sku[], stockKnown: boolean = true): StockLevel {
  if (!stockKnown) return 'in_stock';
  if (skus.length === 0 || available <= 0) return 'out_of_stock';
  if (available < Math.max(1, skus.length) * 10) return 'low_stock';
  return 'in_stock';
}

export interface ListingPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly offset: number;
}

/** Accepts either `limit`/`offset` or `page`/`pageSize`; clamps to safe bounds. */
export function resolveListingPagination(filters: Pick<ListListingsFilters, 'limit' | 'offset' | 'page' | 'pageSize'>): ListingPagination {
  const rawPageSize: number = filters.pageSize ?? filters.limit ?? LISTING_DEFAULT_PAGE_SIZE;
  const pageSize: number = integer({ min: 1, max: LISTING_MAX_PAGE_SIZE })(rawPageSize);
  let page: number;
  let offset: number;
  if (filters.offset !== undefined) {
    offset = nonNegativeInteger()(filters.offset);
    page = Math.floor(offset / pageSize) + 1;
  } else {
    page = integer({ min: 1 })(filters.page ?? 1);
    offset = (page - 1) * pageSize;
  }
  return Object.freeze({ page, pageSize, offset });
}

export function buildPageMeta(total: number, page: number, pageSize: number): PageMeta {
  const totalPages: number = total === 0 ? 0 : Math.ceil(total / pageSize);
  return Object.freeze({
    total,
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  });
}

type ListingSort = NonNullable<ListListingsFilters['sort']>;

function compareListings(sort: ListingSort): (a: ListingView, b: ListingView) => number {
  const direction: number = sort === 'price_desc' || sort === 'title_desc' || sort === 'oldest' ? -1 : 1;
  return (a: ListingView, b: ListingView): number => {
    switch (sort) {
      case 'price_asc':
      case 'price_desc': {
        const left: number = a.priceFromMinor ?? Number.MAX_SAFE_INTEGER;
        const right: number = b.priceFromMinor ?? Number.MAX_SAFE_INTEGER;
        if (left !== right) return (left - right) * direction;
        return a.title.localeCompare(b.title);
      }
      case 'title_asc':
      case 'title_desc': {
        const byTitle: number = a.title.localeCompare(b.title);
        if (byTitle !== 0) return byTitle * direction;
        return a.id.localeCompare(b.id);
      }
      case 'oldest': {
        const byCreated: number = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        return byCreated !== 0 ? byCreated * direction : a.id.localeCompare(b.id);
      }
      case 'newest':
      default: {
        const byCreated: number = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
      }
    }
  };
}

function requireMoney(value: unknown): Money {
  if (value instanceof Money) return value;
  throw ValidationError.field('unitPrice', 'Prices must be Money instances');
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (tags === undefined) return Object.freeze([]);
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') throw ValidationError.field('tags', 'Tags must be strings');
    const tag: string = raw.trim().toLowerCase();
    if (tag.length === 0) continue;
    if (!TAG_PATTERN.test(tag)) throw ValidationError.field('tags', `Invalid tag '${raw}'`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > 20) throw ValidationError.field('tags', 'A product may carry at most 20 tags');
  return Object.freeze(out);
}

function matchesTerm(term: string, product: Product, sku: Sku | undefined): boolean {
  const haystack: string = [
    product.title,
    product.description,
    product.brand ?? '',
    product.tags.join(' '),
    sku?.title ?? '',
    sku?.skuCode ?? '',
    ...Object.values(sku?.attributes ?? {}),
  ]
    .join(' ')
    .toLowerCase();
  return term.split(/\s+/).every((token: string) => haystack.includes(token));
}

function relevanceScore(term: string, product: Product, skuCount: number): number {
  let score: number = skuCount;
  const title: string = product.title.toLowerCase();
  if (term.length > 0) {
    if (title === term) score += 100;
    else if (title.startsWith(term)) score += 50;
    else if (title.includes(term)) score += 20;
  }
  if (product.status === 'published') score += 5;
  return score;
}

function minMoney(values: readonly Money[]): Money | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((lowest: Money, value: Money) => (value.lessThan(lowest) ? value : lowest));
}

function maxMoney(values: readonly Money[]): Money | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((highest: Money, value: Money) => (value.greaterThan(highest) ? value : highest));
}
