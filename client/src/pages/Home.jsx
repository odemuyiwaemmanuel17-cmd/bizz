import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

function Home() {
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchListings();
  }, []);

  const fetchListings = async () => {
    try {
      const response = await axios.get('/api/listings?limit=6');
      setListings(response.data.listings || []);
    } catch (error) {
      console.error('Error fetching listings:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <section className="hero">
        <h1>Connect with Buyers & Sellers Worldwide</h1>
        <p>
          The ultimate platform for businesses of all sizes to find and interact 
          with each other. Whether you're a small business or large enterprise, 
          discover opportunities that drive growth.
        </p>
        <div className="hero-buttons">
          <Link to="/listings" className="btn btn-large btn-primary">
            Browse Listings
          </Link>
          <Link to="/register" className="btn btn-large btn-secondary">
            Get Started
          </Link>
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: '1rem' }}>Featured Listings</h2>
        
        {loading ? (
          <div className="loading">Loading listings...</div>
        ) : listings.length > 0 ? (
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
        ) : (
          <p>No listings available yet. Be the first to create one!</p>
        )}

        {!loading && listings.length > 0 && (
          <div style={{ textAlign: 'center', marginTop: '2rem' }}>
            <Link to="/listings" className="btn btn-primary">
              View All Listings
            </Link>
          </div>
        )}
      </section>

      <section style={{ marginTop: '4rem' }}>
        <h2 style={{ marginBottom: '1rem' }}>Why Choose Business Marketplace?</h2>
        <div className="cards-grid">
          <div className="card">
            <div className="card-content">
              <h3 className="card-title">For Buyers</h3>
              <p className="card-description">
                Discover products and services from verified sellers worldwide. 
                Compare options, negotiate prices, and build lasting business relationships.
              </p>
            </div>
          </div>
          <div className="card">
            <div className="card-content">
              <h3 className="card-title">For Sellers</h3>
              <p className="card-description">
                Reach a global audience of qualified buyers. Showcase your products, 
                manage inquiries, and grow your business efficiently.
              </p>
            </div>
          </div>
          <div className="card">
            <div className="card-content">
              <h3 className="card-title">All Business Sizes</h3>
              <p className="card-description">
                Whether you're a small startup or large enterprise, our platform 
                connects businesses of all scales for mutual growth and success.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default Home;
