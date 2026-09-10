import { useState, useEffect } from 'react';
import axios from 'axios';

function Messages({ user }) {
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchConversations();
  }, []);

  const fetchConversations = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get('/api/messages/conversations', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setConversations(response.data);
    } catch (error) {
      console.error('Error fetching conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  const selectConversation = async (conversationId) => {
    setSelectedConversation(conversationId);
    try {
      const token = localStorage.getItem('token');
      const response = await axios.get(`/api/messages/${conversationId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setMessages(response.data.messages);
    } catch (error) {
      console.error('Error fetching messages:', error);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedConversation) return;

    try {
      const token = localStorage.getItem('token');
      const response = await axios.post(
        `/api/messages/${selectedConversation}`,
        { content: newMessage },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      
      setMessages(prev => [...prev, response.data]);
      setNewMessage('');
      
      // Update conversations list
      fetchConversations();
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message');
    }
  };

  const getOtherParticipant = (conversation) => {
    const other = conversation.participants.find(p => p._id !== user._id);
    return other;
  };

  if (loading) {
    return <div className="loading">Loading messages...</div>;
  }

  return (
    <div>
      <h1 style={{ marginBottom: '2rem' }}>Messages</h1>

      <div className="messages-container">
        <div className="conversations-list">
          {conversations.length > 0 ? (
            conversations.map((conversation) => {
              const other = getOtherParticipant(conversation);
              return (
                <div
                  key={conversation._id}
                  className={`conversation-item ${
                    selectedConversation === conversation._id ? 'active' : ''
                  }`}
                  onClick={() => selectConversation(conversation._id)}
                >
                  <div className="conversation-header">
                    <span className="conversation-name">
                      {other?.businessName || other?.name || 'Unknown'}
                    </span>
                    {conversation.lastMessage && (
                      <span className="conversation-time">
                        {new Date(conversation.lastMessage.createdAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {conversation.lastMessage && (
                    <div className="conversation-preview">
                      {conversation.lastMessage.content}
                    </div>
                  )}
                  {conversation.listing && (
                    <div style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.5rem' }}>
                      Re: {conversation.listing.title}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
              No conversations yet. Start messaging sellers or buyers!
            </div>
          )}
        </div>

        <div className="chat-window">
          {selectedConversation ? (
            <>
              <div className="chat-messages">
                {messages.map((message) => (
                  <div
                    key={message._id}
                    className={`message ${
                      message.sender._id === user._id ? 'sent' : 'received'
                    }`}
                  >
                    <div className="message-bubble">
                      {message.content}
                    </div>
                    <div className="message-time">
                      {new Date(message.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>

              <form onSubmit={sendMessage} className="chat-input">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  placeholder="Type your message..."
                  autoFocus
                />
                <button type="submit">Send</button>
              </form>
            </>
          ) : (
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center', 
              height: '100%',
              color: '#888'
            }}>
              Select a conversation to start messaging
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Messages;
