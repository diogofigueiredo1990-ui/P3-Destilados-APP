import { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase/config';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [usuario, setUsuario] = useState(null);
  const [perfil, setPerfil] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const snap = await getDoc(doc(db, 'usuarios', firebaseUser.uid));
        if (snap.exists()) {
          const data = snap.data();
          if (data.ativo === false) {
            await signOut(auth);
            setUsuario(null);
            setPerfil(null);
            setCarregando(false);
            return;
          }
          setPerfil(data);
        }
        setUsuario(firebaseUser);
      } else {
        setUsuario(null);
        setPerfil(null);
      }
      setCarregando(false);
    });
    return unsubscribe;
  }, []);

  async function login(email, senha) {
    return signInWithEmailAndPassword(auth, email, senha);
  }

  async function logout() {
    return signOut(auth);
  }

  return (
    <AuthContext.Provider value={{ usuario, perfil, carregando, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
