/**
 * Login — credential entry page for the Adjuster Workbench.
 *
 * Why this page exists
 * --------------------
 * Every other route in the Workbench is gated by a JWT. `Login` is the
 * one screen a user reaches before they have one: it accepts a username
 * and password, calls `POST /auth/login` via the auth context, and on
 * success hands control back to whichever route the user originally
 * tried to reach (or to `/claims` by default).
 *
 * The brief explicitly scopes this page narrowly — "reuse of Phase 1's
 * Login.tsx pattern", no SSO, no OAuth, no password recovery, no
 * registration. Track A is local JWT auth and nothing more. The page
 * therefore deliberately keeps its surface small:
 *
 *   - Two text inputs (username, password) with sensible autocomplete
 *     hints so password managers behave.
 *   - A single submit button that disables itself while the request is
 *     in flight, so a double-tap cannot create two concurrent login
 *     attempts.
 *   - One inline error region for credential failures and transport
 *     errors, announced to assistive tech via `role="alert"`.
 *   - The Yotsuba product mark and a one-line reminder that this is the
 *     Claims Workbench — useful when a screenshot of this screen lands
 *     in a review deck.
 *
 * Routing
 * -------
 * If a signed-in user lands here (e.g. by hitting the back button after
 * authentication) we redirect them to `/claims` rather than rendering
 * the form again — there is no useful state for them to be in here.
 * On successful sign-in we honour `location.state.from` so a user who
 * was bounced from `/claims/abc123` returns to that URL rather than
 * being dropped at the default landing page.
 *
 * Accessibility
 * -------------
 * The form is labelled, every input has an associated `<label>`, error
 * text is announced via `role="alert"`, and focus is moved into the
 * username field on mount so keyboard users can begin typing
 * immediately.
 */

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Location } from 'react-router-dom';

import { useAuth } from '../lib/auth';

// ─────────────────────────── route-state shape ─────────────────────────

/**
 * Shape of the `state` object we expect on the location when a
 * protected route bounces the user here. Other code paths may navigate
 * to `/login` without state at all, so every field is optional and
 * defensively unwrapped at the use site.
 */
interface LoginLocationState {
  readonly from?: {
    readonly pathname?: string;
  };
}

function resolveRedirectTarget(location: Location): string {
  const state = location.state as LoginLocationState | null | undefined;
  const pathname = state?.from?.pathname;
  if (typeof pathname === 'string' && pathname.length > 0 && pathname !== '/login') {
    return pathname;
  }
  return '/claims';
}

// ─────────────────────────── product mark ──────────────────────────────

/**
 * Compact product mark mirroring the one in `Layout.tsx`. Kept inline
 * rather than imported so the login page can render without the
 * authenticated chrome — `Layout` assumes a signed-in user.
 */
function ProductMark(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2" aria-label="Yotsuba Claims">
      <span
        aria-hidden="true"
        className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-600 text-lg font-bold text-white shadow-sm"
      >
        Y
      </span>
      <div className="flex flex-col items-center leading-tight">
        <span className="text-base font-semibold text-slate-900">Yotsuba</span>
        <span className="text-xs uppercase tracking-wide text-slate-500">
          Claims Workbench
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────── error normalisation ───────────────────────

/**
 * Coerce whatever the auth layer threw into a user-facing string. The
 * API surface returns a standardised error envelope (see
 * `common/error.filter.ts`), so we look for a `message` field first;
 * falling back to a generic phrase keeps the UI honest if the
 * transport itself failed (network error, etc.).
 */
function describeSignInError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Sign-in failed. Check your credentials and try again.';
}

// ───────────────────────────── component ───────────────────────────────

/**
 * Render the credential entry page.
 *
 * @example
 *   <Route path="/login" element={<Login />} />
 */
export function Login(): JSX.Element {
  const { user, signIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const usernameInputRef = useRef<HTMLInputElement | null>(null);

  // Move focus into the username field on first render so keyboard
  // users can begin typing without an extra tab. We only do this once;
  // re-renders triggered by typing should not steal focus.
  useEffect(() => {
    usernameInputRef.current?.focus();
  }, []);

  // If the user is already signed in, do not render the form at all —
  // bounce them to wherever they came from (or the default landing).
  // Using `<Navigate replace>` keeps the back button sensible.
  if (user) {
    return <Navigate to={resolveRedirectTarget(location)} replace />;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const trimmedUsername = username.trim();
    if (trimmedUsername.length === 0 || password.length === 0) {
      setErrorMessage('Username and password are required.');
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await signIn(trimmedUsername, password);
      navigate(resolveRedirectTarget(location), { replace: true });
    } catch (error) {
      setErrorMessage(describeSignInError(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    void handleSubmit(event);
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center gap-6">
            <ProductMark />

            <div className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
              <header className="mb-6 flex flex-col gap-1">
                <h1 className="text-lg font-semibold text-slate-900">Sign in</h1>
                <p className="text-sm text-slate-500">
                  Authenticate with your Yotsuba workforce credentials to
                  access the Claims Workbench.
                </p>
              </header>

              <form onSubmit={onSubmit} noValidate aria-label="Sign-in form">
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="login-username"
                      className="text-sm font-medium text-slate-700"
                    >
                      Username
                    </label>
                    <input
                      ref={usernameInputRef}
                      id="login-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      disabled={isSubmitting}
                      aria-invalid={errorMessage !== null}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                      placeholder="e.g. tanaka.hiroshi"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label
                      htmlFor="login-password"
                      className="text-sm font-medium text-slate-700"
                    >
                      Password
                    </label>
                    <input
                      id="login-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      disabled={isSubmitting}
                      aria-invalid={errorMessage !== null}
                      className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                      placeholder="••••••••"
                    />
                  </div>

                  {errorMessage ? (
                    <div
                      role="alert"
                      aria-live="polite"
                      className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
                    >
                      {errorMessage}
                    </div>
                  ) : null}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-indigo-400"
                    aria-busy={isSubmitting}
                  >
                    {isSubmitting ? 'Signing in…' : 'Sign in'}
                  </button>
                </div>
              </form>
            </div>

            <p className="px-2 text-center text-xs text-slate-500">
              Access to this system is restricted to authorised personnel.
              Activity is logged to an immutable audit trail in accordance
              with APPI and JFSA requirements.
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-3 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span>© Yotsuba Insurance Holdings — Claims Platform (Track A POC)</span>
          <span className="sm:text-right">
            APPI-aware · JFSA threshold notifications · IFRS17 reserve categories
          </span>
        </div>
      </footer>
    </div>
  );
}

export default Login;