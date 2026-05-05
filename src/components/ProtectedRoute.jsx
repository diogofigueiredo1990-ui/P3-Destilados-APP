import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function ProtectedRoute({ children, apenasAdmin = false }) {
  const { usuario, perfil, carregando } = useAuth();

  if (carregando) {
    return (
      <div style={styles.loading}>
        <div style={styles.spinner} />
        <p>Carregando...</p>
      </div>
    );
  }

  if (!usuario) return <Navigate to="/login" replace />;
  if (apenasAdmin && perfil?.perfil !== 'admin') return <Navigate to="/" replace />;

  return children;
}

const styles = {
  loading: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    color: '#6b7280',
  },
  spinner: {
    width: '36px',
    height: '36px',
    border: '3px solid #e5e7eb',
    borderTop: '3px solid #0f3460',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
};
