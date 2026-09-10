import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

function Dashboard({ user }) {
  const [activeTab, setActiveTab] = useState('listings');
  const [myListings, setMyListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newListing, setNewListing] = useState({
    title: '',
    description: '',
    category: 'other',
    price: { amount: '', currency: 'USD', negotiable: false },
    quantity: { available: 1, unit: 'piece', minOrderQuantity: 1 },
    businessType: user?.businessType || 'small'
  });

  useEffect(() => {
    if (activeTab === 'listings') {
      fetchMyListings();
    }
  }, [activeTab]);

  const fetchMyListings = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/listings/seller/my-listings', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMyListings(response.data);
    } catch (error) {
      console.error('Error fetching listings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateListing = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const listingData = {
        ...newListing,
        price: {
          ...newListing.price,
          amount: parseFloat(newListing.price.amount)
        },
        quantity: {
          ...newListing.quantity,
          available: parseInt(newListing.quantity.available),
          minOrderQuantity: parseInt(newListing.quantity.minOrderQuantity)
        }
      };

      await axios.post('/api/listings', listingData, {
        headers: { Authorization: `Bearer ${token}` }
      });

      setShowCreateForm(false);
      setNewListing({
        title: '',
        description: '',
        category: 'other',
        price: { amount: '', currency: 'USD', negotiable: false },
        quantity: { available: 1, unit: 'piece', minOrderQuantity: 1 },
        businessType: user?.businessType || 'small'
      });
      fetchMyListings();
    } catch (error) {
      console.error('Error creating listing:', error);
      alert('Failed to create listing. Please try again.');
    }
  };

  const handleDeleteListing = async (id) => {
    if (!confirm('Are you sure you want to delete this listing?')) return;

    try {
      const token = localStorage.getItem('token');
      await axios.delete(`/api/listings/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      fetchMyListings();
    } catch (error) {
      console.error('Error deleting listing:', error);
      alert('Failed to delete listing. Please try again.');
    }
  };

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Dashboard - {user?.name}</h1>

      <div className="dashboard-tabs">
        {(user?.role === 'seller' || user?.role === 'both') && (
          <button
            className={`tab-button ${activeTab === 'listings' ? 'active' : ''}`}
            onClick={() => setActiveTab('listings')}
          >
            My Listings
          </button>
        )}
        <button
          className={`tab-button ${activeTab === 'profile' ? 'active' : ''}`}
          onClick={() => setActiveTab('profile')}
        >
          Profile
        </button>
      </div>

      {activeTab === 'listings' && (user?.role === 'seller' || user?.role === 'both') && (
        <div>
          {!showCreateForm ? (
            <>
              <button
                onClick={() => setShowCreateForm(true)}
                className="btn btn-primary"
                style={{ marginBottom: '2rem' }}
              >
                + Create New Listing
              </button>

              {loading ? (
                <div className="loading">Loading your listings...</div>
              ) : myListings.length > 0 ? (
                <div className="cards-grid">
                  {myListings.map((listing) => (
                    <div key={listing._id} className="card">
                      <div className="card-content">
                        <h3 className="card-title">{listing.title}</h3>
                        <div className="card-price">
                          ${listing.price?.amount?.toLocaleString()}
                        </div>
                        <p className="card-description">
                          {listing.description?.substring(0, 80)}...
                        </p>
                        <div className="card-meta">
                          <span>Status: {listing.status}</span>
                          <span>Views: {listing.views}</span>
                        </div>
                        <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                          <Link
                            to={`/listings/${listing._id}`}
                            className="btn btn-secondary"
                            style={{ flex: 1, textAlign: 'center' }}
                          >
                            View
                          </Link>
                          <button
                            onClick={() => handleDeleteListing(listing._id)}
                            className="btn"
                            style={{ 
                              background: '#f44336', 
                              color: 'white',
                              flex: 1
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="loading">
                  <p>You haven't created any listings yet.</p>
                  <button
                    onClick={() => setShowCreateForm(true)}
                    className="btn btn-primary"
                    style={{ marginTop: '1rem' }}
                  >
                    Create Your First Listing
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="form-container" style={{ maxWidth: '700px' }}>
              <h2 style={{ marginBottom: '1.5rem' }}>Create New Listing</h2>
              
              <form onSubmit={handleCreateListing}>
                <div className="form-group">
                  <label className="form-label">Title *</label>
                  <input
                    type="text"
                    value={newListing.title}
                    onChange={(e) => setNewListing(prev => ({ ...prev, title: e.target.value }))}
                    className="form-input"
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Description *</label>
                  <textarea
                    value={newListing.description}
                    onChange={(e) => setNewListing(prev => ({ ...prev, description: e.target.value }))}
                    className="form-textarea"
                    rows="5"
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Category *</label>
                  <select
                    value={newListing.category}
                    onChange={(e) => setNewListing(prev => ({ ...prev, category: e.target.value }))}
                    className="form-select"
                    required
                  >
                    <option value="raw-materials">Raw Materials</option>
                    <option value="manufacturing">Manufacturing</option>
                    <option value="wholesale">Wholesale</option>
                    <option value="retail">Retail</option>
                    <option value="services">Services</option>
                    <option value="technology">Technology</option>
                    <option value="equipment">Equipment</option>
                    <option value="other">Other</option>
                  </select>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div className="form-group">
                    <label className="form-label">Price Amount *</label>
                    <input
                      type="number"
                      value={newListing.price.amount}
                      onChange={(e) => setNewListing(prev => ({ 
                        ...prev, 
                        price: { ...prev.price, amount: e.target.value }
                      }))}
                      className="form-input"
                      required
                      min="0"
                      step="0.01"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Currency</label>
                    <select
                      value={newListing.price.currency}
                      onChange={(e) => setNewListing(prev => ({ 
                        ...prev, 
                        price: { ...prev.price, currency: e.target.value }
                      }))}
                      className="form-select"
                    >
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                      <option value="GBP">GBP</option>
                      <option value="JPY">JPY</option>
                    </select>
                  </div>
                </div>

                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={newListing.price.negotiable}
                      onChange={(e) => setNewListing(prev => ({ 
                        ...prev, 
                        price: { ...prev.price, negotiable: e.target.checked }
                      }))}
                    />
                    Price is negotiable
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
                  <div className="form-group">
                    <label className="form-label">Available Qty</label>
                    <input
                      type="number"
                      value={newListing.quantity.available}
                      onChange={(e) => setNewListing(prev => ({ 
                        ...prev, 
                        quantity: { ...prev.quantity, available: e.target.value }
                      }))}
                      className="form-input"
                      min="1"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Unit</label>
                    <input
                      type="text"
                      value={newListing.quantity.unit}
                      onChange={(e) => setNewListing(prev => ({ 
                        ...prev, 
                        quantity: { ...prev.quantity, unit: e.target.value }
                      }))}
                      className="form-input"
                      placeholder="e.g., piece, kg, ton"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Min Order</label>
                    <input
                      type="number"
                      value={newListing.quantity.minOrderQuantity}
                      onChange={(e) => setNewListing(prev => ({ 
                        ...prev, 
                        quantity: { ...prev.quantity, minOrderQuantity: e.target.value }
                      }))}
                      className="form-input"
                      min="1"
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '1rem', marginTop: '2rem' }}>
                  <button type="submit" className="btn btn-primary">
                    Create Listing
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCreateForm(false)}
                    className="btn btn-secondary"
                    style={{ background: '#ccc', color: '#333' }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {activeTab === 'profile' && (
        <div className="form-container">
          <h2 style={{ marginBottom: '1.5rem' }}>Your Profile</h2>
          
          <div style={{ marginBottom: '1rem' }}>
            <strong>Name:</strong> {user?.name}
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <strong>Email:</strong> {user?.email}
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <strong>Role:</strong> {user?.role}
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <strong>Business Type:</strong> {user?.businessType}
          </div>
          {user?.businessName && (
            <div style={{ marginBottom: '1rem' }}>
              <strong>Business Name:</strong> {user?.businessName}
            </div>
          )}
          {user?.industry && (
            <div style={{ marginBottom: '1rem' }}>
              <strong>Industry:</strong> {user?.industry}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default Dashboard;
