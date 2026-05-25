import React, { createContext, useContext, useEffect, useState } from "react";
import { Auth, getToken, setToken, type AuthMe } from "./api";

type AuthState = {
  user: AuthMe | null;
  loading: boolean;
  login: (u: string, p: string) => Promise<void>;
  logout: () => void;
};

const Ctx = createContext<AuthState>({} as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { setLoading(false); return; }
    Auth.me().then(setUser).catch(() => setToken(null)).finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string): Promise<void> {
    const { access_token } = await Auth.login(username, password);
    setToken(access_token);
    const me = await Auth.me();
    setUser(me);
  }
  function logout() { setToken(null); setUser(null); }
  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
