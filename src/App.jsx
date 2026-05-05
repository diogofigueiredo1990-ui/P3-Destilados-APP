import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import VendedorDashboard from './components/VendedorDashboard';
import AdminDashboard from './components/AdminDashboard';
import FinanceiroDashboard from './components/FinanceiroDashboard';
import ProtectedRoute from './components/ProtectedRoute';

function Home() {
  const { perfil } = useAuth();
  if (perfil?.perfil === 'admin')      return <AdminDashboard />;
  if (perfil?.perfil === 'financeiro') return <FinanceiroDashboard />;
  return <VendedorDashboard />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <style>{`
          * { box-sizing: border-box; }
          body { margin: 0; font-family: 'Inter', sans-serif; }
          @keyframes spin { to { transform: rotate(360deg); } }
        `}</style>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
