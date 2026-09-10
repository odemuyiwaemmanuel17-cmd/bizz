import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

function Listings() {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    search: '',
    category: '',
    businessType: '',
    minPrice: '',
    maxPrice: ''
  });
  const [pagination, setPagination] = useState({ page: 1, total: 0, pages: 0 });

  useEffect(() => {
    fetchListings();
  }, [filters, pagination.page]);

  const fetchListings = async () => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams({
        page: pagination.page,
        limit: 12,
        ...filters
      }).toString();

      const response = await axios.get(`/api/listings?${queryParams}`);
      setListings(response.data.listings || []);
      setPagination(response.data.pagination || { page: 1, total: 0, pages: 0 });
    } catch (error) {
      console.error('Error fetching listings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (e) => {
    const { name, value } = e.target;
    setFilters(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setPagination(prev => ({ ...prev, page: 1 }));
    fetchListings();
  };

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Browse Business Listings</h1>

      <form onSubmit={handleSubmit} className="search-bar">
        <input
          type="text"
          name="search"
          placeholder="Search listings..."
          value={filters.search}
          onChange={handleFilterChange}
          className="search-input"
        />
        
        <select
          name="category"
          value={filters.category}
          onChange={handleFilterChange}
          className="filter-select"
        >
          <option value="">All Categories</option>
          <option value="raw-materials">Raw Materials</option>
          <option value="manufacturing">Manufacturing</option>
          <option value="wholesale">Wholesale</option>
          <option value="retail">Retail</option>
          <option value="services">Services</option>
          <option value="technology">Technology</option>
          <option value="equipment">Equipment</option>
          <option value="other">Other</option>
        </select>

        <select
          name="businessType"
          value={filters.businessType}
          onChange={handleFilterChange}
          className="filter-select"
        >
          <option value="">All Business Types</option>
          <option value="small">Small Business</option>
          <option value="large">Large Business</option>
          <option value="enterprise">Enterprise</option>
        </select>

        <input
          type="number"
          name="minPrice"
          placeholder="Min Price"
          value={filters.minPrice}
          onChange={handleFilterChange}
          className="search-input"
          style={{ maxWidth: '150px' }}
        />

        <input
          type="number"
          name="maxPrice"
          placeholder="Max Price"
          value={filters.maxPrice}
          onChange={handleFilterChange}
          className="search-input"
          style={{ maxWidth: '150px' }}
        />

        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {loading ? (
        <div className="loading">Loading listings...</div>
      ) : listings.length > 0 ? (
        <>
          <div className="cards-grid">
            {listings.map((listing) => (
              <Link to={`/listings/${listing._id}`} key={listing._id} style={{ textDecoration: 'none' }}>
                <div className="card">
                  {listing.images && listing.images.length > 0 ? (
                    <img 
                      src={listing.images[0].url} 
                      alt={listing.title}
                      className="card-image"
                    />
                  ) : (
                    <div className="card-image" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
                      No Image
                    </div>
                  )}
                  <div className="card-content">
                    <h3 className="card-title">{listing.title}</h3>
                    <div className="card-price">
                      ${listing.price?.amount?.toLocaleString()} {listing.price?.currency}
                    </div>
                    <p className="card-description">
                      {listing.description?.substring(0, 100)}...
                    </p>
                    <div className="card-meta">
                      <span>{listing.category}</span>
                      <span>{listing.businessType}</span>
                    </div>
                    {listing.seller && (
                      <div className="card-seller">
                        <div className="seller-avatar">
                          {listing.seller.businessName?.charAt(0) || listing.seller.name?.charAt(0) || 'S'}
                        </div>
                        <span>{listing.seller.businessName || listing.seller.name}</span>
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '2rem', alignItems: 'center' }}>
            <button
              onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
              disabled={pagination.page === 1}
              className="btn btn-secondary"
              style={{ opacity: pagination.page === 1 ? 0.5 : 1 }}
            >
              Previous
            </button>
            <span>Page {pagination.page} of {pagination.pages || 1}</span>
            <button
              onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
              disabled={pagination.page >= pagination.pages}
              className="btn btn-secondary"
              style={{ opacity: pagination.page >= pagination.pages ? 0.5 : 1 }}
            >
              Next
            </button>
          </div>
        </>
      ) : (
        <div className="loading">
          <p>No listings found matching your criteria.</p>
          <button onClick={() => {
            setFilters({ search: '', category: '', businessType: '', minPrice: '', maxPrice: '' });
            setPagination({ page: 1, total: 0, pages: 0 });
          }} className="btn btn-primary" style={{ marginTop: '1rem' }}>
            Clear Filters
          </button>
        </div>
      )}
    </div>
  );
}

export default Listings;
