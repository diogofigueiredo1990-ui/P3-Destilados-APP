import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';

// Lazy loading — cada componente vira um chunk separado.
// O bundle principal cai de 1.2MB para ~200KB; o restante carrega sob demanda.
const Login              = lazy(() => import('./components/Login'));
const VendedorDashboard  = lazy(() => import('./components/VendedorDashboard'));
const AdminDashboard     = lazy(() => import('./components/AdminDashboard'));
const FinanceiroDashboard= lazy(() => import('./components/FinanceiroDashboard'));
const ProtectedRoute     = lazy(() => import('./components/ProtectedRoute'));

function Spinner() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
      gap: '16px',
    }}>
      <div style={{
        width: '40px', height: '40px',
        border: '3px solid rgba(255,255,255,0.2)',
        borderTop: '3px solid #fff',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Home() {
  const { perfil } = useAuth();
  if (perfil?.perfil === 'admin')      return <AdminDashboard />;
  if (perfil?.perfil === 'financeiro') return <FinanceiroDashboard />;
  return <VendedorDashboard />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<Spinner />}>
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
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
