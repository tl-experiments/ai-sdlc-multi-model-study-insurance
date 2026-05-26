/**
 * Tailwind CSS configuration for the Yotsuba Adjuster Workbench.
 *
 * The design system is intentionally restrained: a neutral slate base with
 * carrier-friendly accents for the claim status pills, severity pills, and
 * role badges. Colour tokens map 1-to-1 onto the enums in the Prisma schema
 * (`ClaimStatus`, `ClaimSeverity`, `UserRole`) so components can derive their
 * classes from backend values without an intermediate translation layer.
 */

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{ts,tsx,js,jsx,html}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Hiragino Kaku Gothic ProN',
          'Hiragino Sans',
          'Noto Sans JP',
          'Yu Gothic',
          'Meiryo',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'Liberation Mono',
          'Courier New',
          'monospace',
        ],
      },
      colors: {
        // Carrier brand surface — used for the top bar and primary CTAs.
        brand: {
          50: '#eef4ff',
          100: '#dbe6ff',
          200: '#b8ccff',
          300: '#8eabff',
          400: '#6385f5',
          500: '#4163e0',
          600: '#2f4cc2',
          700: '#263e9c',
          800: '#1f3380',
          900: '#172663',
          950: '#0d1740',
        },
        // Claim status palette — keys mirror the `ClaimStatus` enum.
        status: {
          intake: '#64748b',
          under_investigation: '#0284c7',
          awaiting_reserve_approval: '#d97706',
          settlement_offered: '#7c3aed',
          closed_paid: '#16a34a',
          closed_denied: '#dc2626',
          reopened: '#db2777',
        },
        // Severity palette — keys mirror the `ClaimSeverity` enum.
        severity: {
          simple: '#16a34a',
          complex: '#d97706',
          catastrophic: '#b91c1c',
        },
        // Role badge palette — keys mirror the `UserRole` enum.
        role: {
          agent: '#0ea5e9',
          adjuster: '#2f4cc2',
          manager: '#7c3aed',
          auditor: '#475569',
          siu_referrer: '#b91c1c',
        },
      },
      spacing: {
        '18': '4.5rem',
        '72': '18rem',
        '88': '22rem',
        '112': '28rem',
        '128': '32rem',
      },
      maxWidth: {
        '8xl': '88rem',
        '9xl': '96rem',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        'card-lg': '0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(15 23 42 / 0.05)',
        focus: '0 0 0 3px rgb(65 99 224 / 0.35)',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      transitionDuration: {
        '250': '250ms',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(2px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-subtle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.75' },
        },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out',
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
      },
    },
  },
  // Tailwind v3 tree-shakes unused classes, but the status/severity/role colour
  // classes are generated dynamically from backend enum strings (e.g.
  // `bg-status-${claim.status}`). Safelist the full set so JIT doesn't drop them.
  safelist: [
    // Claim status
    'bg-status-intake', 'text-status-intake', 'border-status-intake',
    'bg-status-under_investigation', 'text-status-under_investigation', 'border-status-under_investigation',
    'bg-status-awaiting_reserve_approval', 'text-status-awaiting_reserve_approval', 'border-status-awaiting_reserve_approval',
    'bg-status-settlement_offered', 'text-status-settlement_offered', 'border-status-settlement_offered',
    'bg-status-closed_paid', 'text-status-closed_paid', 'border-status-closed_paid',
    'bg-status-closed_denied', 'text-status-closed_denied', 'border-status-closed_denied',
    'bg-status-reopened', 'text-status-reopened', 'border-status-reopened',
    // Severity
    'bg-severity-simple', 'text-severity-simple', 'border-severity-simple',
    'bg-severity-complex', 'text-severity-complex', 'border-severity-complex',
    'bg-severity-catastrophic', 'text-severity-catastrophic', 'border-severity-catastrophic',
    // Role
    'bg-role-agent', 'text-role-agent', 'border-role-agent',
    'bg-role-adjuster', 'text-role-adjuster', 'border-role-adjuster',
    'bg-role-manager', 'text-role-manager', 'border-role-manager',
    'bg-role-auditor', 'text-role-auditor', 'border-role-auditor',
    'bg-role-siu_referrer', 'text-role-siu_referrer', 'border-role-siu_referrer',
  ],
  plugins: [],
};