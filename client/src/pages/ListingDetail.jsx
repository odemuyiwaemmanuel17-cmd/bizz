import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';

function ListingDetail() {
  const { id } = useParams();
  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [user, setUser] = useState(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
    fetchListing();
  }, [id]);

  const fetchListing = async () => {
    try {
      const response = await axios.get(`/api/listings/${id}`);
      setListing(response.data);
    } catch (error) {
      console.error('Error fetching listing:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleContactSeller = async () => {
    if (!user) {
      setMessage('Please login to contact the seller');
      return;
    }

    try {
      const token = localStorage.getItem('token');
      await axios.post(
        '/api/messages/conversation',
        { recipientId: listing.seller._id, listingId: listing._id },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setMessage('Conversation started! Check your messages.');
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      setMessage('Error starting conversation. Please try again.');
      console.error(error);
    }
  };

  if (loading) {
    return <div className="loading">Loading listing details...</div>;
  }

  if (!listing) {
    return <div className="loading">Listing not found</div>;
  }

  return (
    <div>
      <Link to="/listings" className="btn btn-secondary" style={{ marginBottom: '2rem', display: 'inline-block' }}>
        ← Back to Listings
      </Link>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', marginBottom: '2rem' }}>
        <div>
          {listing.images && listing.images.length > 0 ? (
            <img 
              src={listing.images[0].url} 
              alt={listing.title}
              style={{ width: '100%', borderRadius: '10px', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ 
              width: '100%', 
              height: '400px', 
              background: '#e0e0e0', 
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#999'
            }}>
              No Image Available
            </div>
          )}
        </div>

        <div>
          <h1 style={{ marginBottom: '1rem' }}>{listing.title}</h1>
          
          <div className="card-price" style={{ fontSize: '2rem', marginBottom: '1rem' }}>
            ${listing.price?.amount?.toLocaleString()} {listing.price?.currency}
            {listing.price?.negotiable && (
              <span style={{ fontSize: '1rem', color: '#888', marginLeft: '0.5rem' }}>
                (Negotiable)
              </span>
            )}
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <span style={{ 
              background: '#667eea', 
              color: 'white', 
              padding: '0.25rem 0.75rem', 
              borderRadius: '20px',
              fontSize: '0.9rem',
              marginRight: '0.5rem'
            }}>
              {listing.category}
            </span>
            <span style={{ 
              background: '#4CAF50', 
              color: 'white', 
              padding: '0.25rem 0.75rem', 
              borderRadius: '20px',
              fontSize: '0.9rem'
            }}>
              {listing.businessType}
            </span>
          </div>

          <p style={{ marginBottom: '1.5rem', lineHeight: '1.8', color: '#555' }}>
            {listing.description}
          </p>

          {listing.quantity && (
            <div style={{ marginBottom: '1rem' }}>
              <strong>Quantity Available:</strong> {listing.quantity.available} {listing.quantity.unit}
              {listing.quantity.minOrderQuantity > 1 && (
                <span> (Min order: {listing.quantity.minOrderQuantity})</span>
              )}
            </div>
          )}

          {listing.shipping?.available && (
            <div style={{ marginBottom: '1rem' }}>
              <strong>Shipping:</strong> Available
              {listing.shipping.regions && listing.shipping.regions.length > 0 && (
                <span> to {listing.shipping.regions.join(', ')}</span>
              )}
            </div>
          )}

          {listing.location && (
            <div style={{ marginBottom: '1rem' }}>
              <strong>Location:</strong>{' '}
              {[listing.location.city, listing.location.state, listing.location.country]
                .filter(Boolean)
                .join(', ')}
            </div>
          )}

          <div style={{ marginTop: '2rem' }}>
            {user && user._id !== listing.seller._id ? (
              <button onClick={handleContactSeller} className="btn btn-primary btn-large">
                Contact Seller
              </button>
            ) : user?._id === listing.seller._id ? (
              <p style={{ color: '#4CAF50' }}>This is your listing</p>
            ) : (
              <Link to="/login" className="btn btn-primary btn-large">
                Login to Contact Seller
              </Link>
            )}
            
            {message && (
              <p style={{ 
                marginTop: '1rem', 
                color: message.includes('Error') ? '#c62828' : '#2e7d32' 
              }}>
                {message}
              </p>
            )}
          </div>
        </div>
      </div>

      {listing.seller && (
        <div style={{ 
          background: 'white', 
          padding: '2rem', 
          borderRadius: '10px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.1)'
        }}>
          <h2 style={{ marginBottom: '1rem' }}>Seller Information</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div className="seller-avatar" style={{ width: '60px', height: '60px', fontSize: '1.5rem' }}>
              {listing.seller.businessName?.charAt(0) || listing.seller.name?.charAt(0) || 'S'}
            </div>
            <div>
              <h3 style={{ marginBottom: '0.25rem' }}>
                {listing.seller.businessName || listing.seller.name}
              </h3>
              <p style={{ color: '#666', marginBottom: '0.5rem' }}>
                {listing.seller.industry && `${listing.seller.industry} • `}
                {listing.seller.businessType} Business
              </p>
              {listing.seller.location && (
                <p style={{ color: '#888', fontSize: '0.9rem' }}>
                  {[listing.seller.location.city, listing.seller.location.country]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
              {listing.seller.verified && (
                <span style={{ 
                  background: '#4CAF50', 
                  color: 'white', 
                  padding: '0.25rem 0.5rem', 
                  borderRadius: '3px',
                  fontSize: '0.8rem'
                }}>
                  ✓ Verified
                </span>
              )}
            </div>
          </div>
          {listing.seller.bio && (
            <p style={{ marginTop: '1rem', color: '#555', lineHeight: '1.6' }}>
              {listing.seller.bio}
            </p>
          )}
        </div>
      )}

      <div style={{ marginTop: '2rem', color: '#888', fontSize: '0.9rem' }}>
        <p>Posted: {new Date(listing.createdAt).toLocaleDateString()}</p>
        <p>Views: {listing.views}</p>
      </div>
    </div>
  );
}

export default ListingDetail;
