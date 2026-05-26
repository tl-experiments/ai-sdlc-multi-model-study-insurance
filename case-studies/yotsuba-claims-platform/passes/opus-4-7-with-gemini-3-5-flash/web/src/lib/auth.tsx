import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export interface User {
  id: string;
  name: string;
  email: string;
  companyName?: string;
  role: 'admin' | 'architect' | 'viewer';
  avatarUrl?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (name: string, email: string, companyName: string) => Promise<void>;
  updateProfile: (updates: Partial<User>) => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const LOCAL_STORAGE_KEY = 'archimedes_auth_user';

// Mock users database for simulation
const MOCK_USERS: User[] = [
  {
    id: 'usr-1',
    name: 'Alex Rivera',
    email: 'alex@archimedes.ai',
    companyName: 'Archimedes Corp',
    role: 'architect',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&h=100&fit=crop&crop=faces'
  },
  {
    id: 'usr-2',
    name: 'Demo User',
    email: 'demo@example.com',
    companyName: 'CloudScale Inc',
    role: 'admin',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop&crop=faces'
  }
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Initialize auth state from localStorage
    const initializeAuth = () => {
      try {
        const storedUser = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (storedUser) {
          setUser(JSON.parse(storedUser));
        }
      } catch (err) {
        console.error('Failed to parse stored auth user:', err);
        localStorage.removeItem(LOCAL_STORAGE_KEY);
      } finally {
        setIsLoading(false);
      }
    };

    initializeAuth();
  }, []);

  const login = async (email: string, password: string): Promise<void> => {
    setIsLoading(true);
    setError(null);
    
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 800));

    if (!email || !password) {
      setError('Email and password are required.');
      setIsLoading(false);
      throw new Error('Email and password are required.');
    }

    // Simple validation: check if email exists in mock users
    const matchedUser = MOCK_USERS.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );

    if (matchedUser) {
      setUser(matchedUser);
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(matchedUser));
      setIsLoading(false);
      return;
    }

    // If not in mock users, allow any password for demo purposes but create a dynamic user
    if (email.includes('@') && password.length >= 4) {
      const newUser: User = {
        id: `usr-${Math.random().toString(36).substring(2, 9)}`,
        name: email.split('@')[0].replace(/[^a-zA-Z]/g, ' '),
        email: email.toLowerCase(),
        companyName: 'My Organization',
        role: 'admin'
      };
      setUser(newUser);
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newUser));
      setIsLoading(false);
      return;
    }

    setError('Invalid credentials. Try alex@archimedes.ai or demo@example.com with any password.');
    setIsLoading(false);
    throw new Error('Invalid credentials.');
  };

  const logout = async (): Promise<void> => {
    setIsLoading(true);
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 400));
    setUser(null);
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    setIsLoading(false);
  };

  const register = async (name: string, email: string, companyName: string): Promise<void> => {
    setIsLoading(true);
    setError(null);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (!name || !email) {
      setError('Name and email are required.');
      setIsLoading(false);
      throw new Error('Name and email are required.');
    }

    if (!email.includes('@')) {
      setError('Please enter a valid email address.');
      setIsLoading(false);
      throw new Error('Invalid email address.');
    }

    const newUser: User = {
      id: `usr-${Math.random().toString(36).substring(2, 9)}`,
      name,
      email: email.toLowerCase(),
      companyName: companyName || 'Independent',
      role: 'admin'
    };

    setUser(newUser);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newUser));
    setIsLoading(false);
  };

  const updateProfile = async (updates: Partial<User>): Promise<void> => {
    if (!user) {
      setError('No authenticated user found.');
      throw new Error('No authenticated user found.');
    }

    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const updatedUser = {
      ...user,
      ...updates,
      id: user.id,
      role: updates.role || user.role
    };

    setUser(updatedUser);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updatedUser));
    setIsLoading(false);
  };

  const clearError = () => {
    setError(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        error,
        login,
        logout,
        register,
        updateProfile,
        clearError
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}