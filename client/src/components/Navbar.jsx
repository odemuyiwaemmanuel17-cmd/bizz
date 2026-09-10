import { Link } from 'react-router-dom';

function Navbar({ user, logout }) {
  return (
    <nav className="navbar">
      <Link to="/" className="navbar-brand">
        Business Marketplace
      </Link>
      
      <div className="navbar-links">
        <Link to="/">Home</Link>
        <Link to="/listings">Browse Listings</Link>
        {user && <Link to="/dashboard">Dashboard</Link>}
        {user && <Link to="/messages">Messages</Link>}
      </div>
      
      <div className="navbar-buttons">
        {user ? (
          <>
            <span style={{ color: 'white' }}>Welcome, {user.name}</span>
            <button onClick={logout} className="btn btn-secondary">
              Logout
            </button>
          </>
        ) : (
          <>
            <Link to="/login" className="btn btn-secondary">
              Login
            </Link>
            <Link to="/register" className="btn btn-primary">
              Sign Up
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}

export default Navbar;
