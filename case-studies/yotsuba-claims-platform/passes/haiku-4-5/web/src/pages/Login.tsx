/**
 * Login.tsx
 * Authentication page for the Adjuster Workbench.
 * Handles user login with username and password, stores JWT token, and redirects to claims queue.
 * Displays validation errors and loading state during authentication.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * Login form data structure.
 */
interface LoginFormData {
  username: string;
  password: string;
}

/**
 * Login error structure.
 */
interface LoginError {
  field?: string;
  message: string;
}

/**
 * Login component — authentication page for the Adjuster Workbench.
 * Displays a login form with username and password fields.
 * On successful authentication, stores the JWT token and redirects to the claims queue.
 * @returns Rendered login page
 */
export const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [formData, setFormData] = useState<LoginFormData>({
    username: '',
    password: '',
  });

  const [errors, setErrors] = useState<LoginError[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  /**
   * Validate form data before submission.
   * @returns Array of validation errors; empty if valid
   */
  const validateForm = (): LoginError[] => {
    const validationErrors: LoginError[] = [];

    if (!formData.username.trim()) {
      validationErrors.push({
        field: 'username',
        message: 'Username is required',
      });
    }

    if (!formData.password) {
      validationErrors.push({
        field: 'password',
        message: 'Password is required',
      });
    }

    if (formData.password && formData.password.length < 1) {
      validationErrors.push({
        field: 'password',
        message: 'Password must not be empty',
      });
    }

    return validationErrors;
  };

  /**
   * Handle form input changes.
   */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    // Clear errors for this field when user starts typing
    setErrors((prev) => prev.filter((err) => err.field !== name));
    setGeneralError(null);
  };

  /**
   * Handle form submission.
   */
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrors([]);
    setGeneralError(null);

    // Validate form
    const validationErrors = validateForm();
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsLoading(true);

    try {
      // Call login from auth context
      await login(formData.username, formData.password);
      // Redirect to claims queue on successful login
      navigate('/claims');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Login failed. Please try again.';
      setGeneralError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Get error message for a specific field.
   */
  const getFieldError = (field: string): string | null => {
    const error = errors.find((err) => err.field === field);
    return error ? error.message : null;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Card container */}
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-8 text-center">
            <div className="text-5xl mb-3">🏢</div>
            <h1 className="text-2xl font-bold text-white">Yotsuba Claims</h1>
            <p className="text-blue-100 text-sm mt-2">Adjuster Workbench</p>
          </div>

          {/* Form container */}
          <div className="px-6 py-8">
            {/* General error message */}
            {generalError && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-sm text-red-700 font-medium">⚠️ {generalError}</p>
              </div>
            )}

            {/* Login form */}
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Username field */}
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-gray-700 mb-2">
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  value={formData.username}
                  onChange={handleInputChange}
                  disabled={isLoading}
                  className={`w-full px-4 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${
                    getFieldError('username')
                      ? 'border-red-300 bg-red-50'
                      : 'border-gray-300 bg-white'
                  } disabled:bg-gray-100 disabled:cursor-not-allowed`}
                  placeholder="Enter your username"
                  autoComplete="username"
                />
                {getFieldError('username') && (
                  <p className="mt-1.5 text-xs text-red-600 font-medium">
                    {getFieldError('username')}
                  </p>
                )}
              </div>

              {/* Password field */}
              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-2">
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  value={formData.password}
                  onChange={handleInputChange}
                  disabled={isLoading}
                  className={`w-full px-4 py-2.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${
                    getFieldError('password')
                      ? 'border-red-300 bg-red-50'
                      : 'border-gray-300 bg-white'
                  } disabled:bg-gray-100 disabled:cursor-not-allowed`}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
                {getFieldError('password') && (
                  <p className="mt-1.5 text-xs text-red-600 font-medium">
                    {getFieldError('password')}
                  </p>
                )}
              </div>

              {/* Submit button */}
              <button
                type="submit"
                disabled={isLoading}
                className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg text-sm font-semibold hover:from-blue-700 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-400 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <span className="inline-block animate-spin">⏳</span>
                    <span>Signing in…</span>
                  </>
                ) : (
                  <>
                    <span>🔐</span>
                    <span>Sign In</span>
                  </>
                )}
              </button>
            </form>

            {/* Demo credentials hint */}
            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-xs text-blue-700 font-medium mb-2">Demo Credentials</p>
              <div className="space-y-1 text-xs text-blue-600 font-mono">
                <p>Username: <span className="font-semibold">adjuster1</span></p>
                <p>Password: <span className="font-semibold">password123</span></p>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 text-center">
            <p className="text-xs text-gray-600">
              © 2024 Yotsuba Insurance Holdings. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;