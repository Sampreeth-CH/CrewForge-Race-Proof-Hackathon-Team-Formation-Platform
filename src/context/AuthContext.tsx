import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { api, setAuthToken } from '../lib/api';
import { firebaseAuth, googleAuthProvider, verifyFirestoreConnection } from '../lib/firebase';

export interface UserProfile {
  id: string;
  fullName: string;
  email: string;
  role: 'participant' | 'organizer' | 'admin';
  bio: string;
  skills: string[];
  experienceLevel: 'beginner' | 'intermediate' | 'advanced' | 'staff';
  timezone: string;
  createdAt: string;
}

export interface UserMembership {
  teamId: string;
  teamName: string;
  hackathonId: string;
  hackathonName: string;
  role: string;
}

interface AuthContextValue {
  user: UserProfile | null;
  memberships: UserMembership[];
  loading: boolean;
  login: (email: string, password: string) => Promise<UserProfile>;
  register: (payload: {
    fullName: string;
    email: string;
    password: string;
    bio?: string;
    skills?: string[];
    experienceLevel?: string;
    timezone?: string;
  }) => Promise<UserProfile>;
  loginWithGoogle: () => Promise<UserProfile>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [memberships, setMemberships] = useState<UserMembership[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    try {
      const res = await api.get<{ user: UserProfile | null; memberships: UserMembership[] }>(
        '/auth/session'
      );
      setUser(res.data.user);
      setMemberships(res.data.memberships ?? []);
    } catch {
      setUser(null);
      setMemberships([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
    void verifyFirestoreConnection();
  }, [refreshMe]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ user: UserProfile; token: string }>('/auth/login', {
        email,
        password,
      });
      setAuthToken(res.data.token);
      setUser(res.data.user);
      await refreshMe();
      return res.data.user;
    },
    [refreshMe]
  );

  const register = useCallback(
    async (payload: {
      fullName: string;
      email: string;
      password: string;
      bio?: string;
      skills?: string[];
      experienceLevel?: string;
      timezone?: string;
    }) => {
      const res = await api.post<{ user: UserProfile; token: string }>('/auth/register', payload);
      setAuthToken(res.data.token);
      setUser(res.data.user);
      await refreshMe();
      return res.data.user;
    },
    [refreshMe]
  );

  const loginWithGoogle = useCallback(async () => {
    const cred = await signInWithPopup(firebaseAuth, googleAuthProvider);
    const idToken = await cred.user.getIdToken();
    const res = await api.post<{ user: UserProfile; token: string }>('/auth/firebase', { idToken });
    setAuthToken(res.data.token);
    setUser(res.data.user);
    await refreshMe();
    return res.data.user;
  }, [refreshMe]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setAuthToken(null);
    setUser(null);
    setMemberships([]);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        memberships,
        loading,
        login,
        register,
        loginWithGoogle,
        logout,
        refreshMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
