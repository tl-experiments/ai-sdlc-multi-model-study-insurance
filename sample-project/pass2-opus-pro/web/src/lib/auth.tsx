import React, { createContext, useContext, useEffect, useState } from "react";
import { Auth, getToken, setToken, type AuthMe } from "./api";

type AuthState = {
  user: AuthMe | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthState>({} as AuthState);

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    Auth.me()
      .then(setUser)
      .catch(() => {
        setToken(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  async function login(username: string, password: string): Promise<void> {
    const { access_token } = await Auth.login(username, password);
    setToken(access_token);
    const me = await Auth.me();
    setUser(me);
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}