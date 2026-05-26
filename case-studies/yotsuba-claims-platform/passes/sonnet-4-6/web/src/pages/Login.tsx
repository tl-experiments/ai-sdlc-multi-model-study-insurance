/**
 * Login.tsx
 *
 * Authentication page for the Yotsuba Claims Adjuster Workbench.
 *
 * Design constraints:
 *  - Mirrors the Login.tsx pattern from Phase 1 (referenced in brief.md).
 *  - Uses `useAuth` from `../lib/auth` for login action and state.
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Handles loading, validation, and server error states.
 *  - Redirects to `/claims` on successful authentication.
 *  - Accessible: proper label associations, aria-live error region,
 *    focus management after error.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoginFormState {
  username: string;
  password: string;
}

interface LoginFormErrors {
  username?: string;
  password?: string;
  server?: string;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validates the login form fields.
 * Returns an errors object; an empty object means validation passed.
 */
function validateForm(values: LoginFormState): LoginFormErrors {
  const errors: LoginFormErrors = {};

  if (values.username.trim().length === 0) {
    errors.username = 'Username is required.';
  }

  if (values.password.length === 0) {
    errors.password = 'Password is required.';
  } else if (values.password.length < 6) {
    errors.password = 'Password must be at least 6 characters.';
  }

  return errors;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<Login>` — full-page authentication form.
 *
 * Renders a centred card with username/password inputs, a submit button,
 * inline field-level validation errors, and a server error banner.
 * On successful login, the user is redirected to the claim queue.
 *
 * @example
 * ```tsx
 * // In App.tsx router:
 * <Route path="/login" element={<Login />} />
 * ```
 */
export function Login(): React.ReactElement {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState<LoginFormState>({
    username: '',
    password: '',
  });
  const [errors, setErrors] = useState<LoginFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Ref for the server error region — used for focus management.
  const serverErrorRef = useRef<HTMLParagraphElement>(null);

  // When a server error appears, move focus to it so screen readers announce it.
  useEffect(() => {
    if (errors.server !== undefined && serverErrorRef.current !== null) {
      serverErrorRef.current.focus();
    }
  }, [errors.server]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const { name, value } = e.target;
      setForm((prev) => ({ ...prev, [name]: value }));
      // Clear the field-level error as the user types.
      setErrors((prev) => {
        if (prev[name as keyof LoginFormErrors] === undefined) return prev;
        const next = { ...prev };
        delete next[name as keyof LoginFormErrors];
        return next;
      });
    },
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault();

      // Client-side validation.
      const validationErrors = validateForm(form);
      if (Object.keys(validationErrors).length > 0) {
        setErrors(validationErrors);
        return;
      }

      setIsSubmitting(true);
      setErrors({});

      try {
        await login(form.username.trim(), form.password);
        // Redirect to the claim queue on success.
        navigate('/claims', { replace: true });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : 'Login failed. Please check your credentials and try again.';
        setErrors({ server: message });
      } finally {
        setIsSubmitting(false);
      }
    },
    [form, login, navigate],
  );

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-100 px-4 py-12 sm:px-6 lg:px-8">
      {/* Card */}
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="flex flex-col items-center">
          <YotsubaLogo className="h-14 w-14" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-gray-900">
            Yotsuba Claims
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Adjuster Workbench — Sign in to your account
          </p>
        </div>

        {/* Form card */}
        <div className="rounded-xl bg-white px-8 py-10 shadow-sm ring-1 ring-gray-200">
          {/* Server error banner */}
          {errors.server !== undefined && (
            <div
              role="alert"
              aria-live="assertive"
              className="mb-6 flex items-start gap-3 rounded-lg bg-red-50 px-4 py-3 ring-1 ring-inset ring-red-200"
            >
              <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" aria-hidden />
              <p
                ref={serverErrorRef}
                tabIndex={-1}
                className="text-sm text-red-700 focus:outline-none"
              >
                {errors.server}
              </p>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            noValidate
            aria-label="Sign in form"
            className="space-y-5"
          >
            {/* Username field */}
            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-gray-700"
              >
                Username
              </label>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <UserIcon className="h-4 w-4 text-gray-400" aria-hidden />
                </div>
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  required
                  value={form.username}
                  onChange={handleChange}
                  aria-describedby={
                    errors.username !== undefined ? 'username-error' : undefined
                  }
                  aria-invalid={errors.username !== undefined ? true : undefined}
                  disabled={isSubmitting}
                  placeholder="e.g. adjuster01"
                  className={[
                    'block w-full rounded-lg border py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
                    'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400',
                    'transition-colors',
                    errors.username !== undefined
                      ? 'border-red-400 bg-red-50 focus:ring-red-500 focus:border-red-500'
                      : 'border-gray-300 bg-white',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
              </div>
              {errors.username !== undefined && (
                <p
                  id="username-error"
                  role="alert"
                  className="mt-1.5 flex items-center gap-1 text-xs text-red-600"
                >
                  <AlertIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
                  {errors.username}
                </p>
              )}
            </div>

            {/* Password field */}
            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700"
              >
                Password
              </label>
              <div className="relative mt-1.5">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <LockIcon className="h-4 w-4 text-gray-400" aria-hidden />
                </div>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={form.password}
                  onChange={handleChange}
                  aria-describedby={
                    errors.password !== undefined ? 'password-error' : undefined
                  }
                  aria-invalid={errors.password !== undefined ? true : undefined}
                  disabled={isSubmitting}
                  placeholder="••••••••"
                  className={[
                    'block w-full rounded-lg border py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400',
                    'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
                    'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400',
                    'transition-colors',
                    errors.password !== undefined
                      ? 'border-red-400 bg-red-50 focus:ring-red-500 focus:border-red-500'
                      : 'border-gray-300 bg-white',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />
              </div>
              {errors.password !== undefined && (
                <p
                  id="password-error"
                  role="alert"
                  className="mt-1.5 flex items-center gap-1 text-xs text-red-600"
                >
                  <AlertIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
                  {errors.password}
                </p>
              )}
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={isSubmitting}
              className={[
                'relative flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white',
                'focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2',
                'transition-colors',
                isSubmitting
                  ? 'cursor-not-allowed bg-indigo-400'
                  : 'bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {isSubmitting ? (
                <>
                  <SpinnerIcon className="h-4 w-4 animate-spin" aria-hidden />
                  <span>Signing in…</span>
                </>
              ) : (
                <>
                  <LoginIcon className="h-4 w-4" aria-hidden />
                  <span>Sign in</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400">
          Yotsuba Insurance Holdings · Claims Processing Platform
          <br />
          <span className="text-gray-300">Track A · Internal Use Only</span>
        </p>
      </div>
    </div>
  );
}

// ─── SVG icons ────────────────────────────────────────────────────────────────

interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

function YotsubaLogo({ className = 'h-10 w-10' }: IconProps): React.ReactElement {
  // Matches the logo from Layout.tsx — stylised shield / clover.
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Yotsuba Claims logo"
      role="img"
    >
      <rect width="32" height="32" rx="8" fill="#4F46E5" />
      <path
        d="M16 6C16 6 8 10 8 17a8 8 0 0016 0C24 10 16 6 16 6z"
        fill="white"
        opacity="0.9"
      />
      <path
        d="M16 11a1 1 0 011 1v5.586l2.207 2.207a1 1 0 01-1.414 1.414L16 19.414l-1.793 1.793a1 1 0 01-1.414-1.414L15 17.586V12a1 1 0 011-1z"
        fill="#4F46E5"
      />
    </svg>
  );
}

function UserIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LockIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function AlertIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function LoginIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M3 3a1 1 0 011 1v12a1 1 0 11-2 0V4a1 1 0 011-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SpinnerIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}