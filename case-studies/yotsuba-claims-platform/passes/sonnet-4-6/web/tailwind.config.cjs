/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Yotsuba brand palette — insurance-grade professional
        brand: {
          50:  '#f0f4ff',
          100: '#e0eaff',
          200: '#c7d7fe',
          300: '#a5bafc',
          400: '#8093f8',
          500: '#5c6ef2',
          600: '#4a53e6',
          700: '#3d42cc',
          800: '#3237a4',
          900: '#2d3382',
          950: '#1c1f4d',
        },
        // Status-specific tokens for claim workflow states
        claim: {
          intake:                  '#6b7280', // gray-500
          under_investigation:     '#d97706', // amber-600
          awaiting_reserve_approval: '#7c3aed', // violet-600
          settlement_offered:      '#2563eb', // blue-600
          closed_paid:             '#16a34a', // green-600
          closed_denied:           '#dc2626', // red-600
          reopened:                '#ea580c', // orange-600
        },
        // Severity tokens
        severity: {
          simple:       '#16a34a', // green-600
          complex:      '#d97706', // amber-600
          catastrophic: '#dc2626', // red-600
        },
        // Channel tokens
        channel: {
          agent:  '#7c3aed', // violet-600
          mobile: '#2563eb', // blue-600
          broker: '#0891b2', // cyan-600
          email:  '#4b5563', // gray-600
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'Noto Sans JP',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Fira Code"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      spacing: {
        // Extra spacing tokens for dense workbench layouts
        '4.5': '1.125rem',
        '13':  '3.25rem',
        '15':  '3.75rem',
        '18':  '4.5rem',
        '22':  '5.5rem',
      },
      borderRadius: {
        'sm':  '0.25rem',
        DEFAULT: '0.375rem',
        'md':  '0.5rem',
        'lg':  '0.625rem',
        'xl':  '0.75rem',
        '2xl': '1rem',
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-hover': '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.07)',
        'modal': '0 20px 60px -10px rgb(0 0 0 / 0.25)',
        'sidebar': '2px 0 8px 0 rgb(0 0 0 / 0.05)',
      },
      fontSize: {
        // Workbench-oriented type scale
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        'xs':  ['0.75rem',  { lineHeight: '1rem' }],
        'sm':  ['0.8125rem', { lineHeight: '1.25rem' }],
        'base': ['0.9375rem', { lineHeight: '1.5rem' }],
        'lg':  ['1.0625rem', { lineHeight: '1.75rem' }],
        'xl':  ['1.125rem',  { lineHeight: '1.875rem' }],
        '2xl': ['1.25rem',   { lineHeight: '1.875rem' }],
        '3xl': ['1.5rem',    { lineHeight: '2rem' }],
        '4xl': ['1.875rem',  { lineHeight: '2.25rem' }],
      },
      maxWidth: {
        // Workbench layout containers
        'workbench': '1440px',
        'detail':    '1280px',
        'form':      '640px',
      },
      minWidth: {
        'sidebar': '240px',
        'panel':   '320px',
      },
      zIndex: {
        'sidebar':  '40',
        'header':   '50',
        'modal':    '60',
        'toast':    '70',
        'tooltip':  '80',
      },
      transitionDuration: {
        '250': '250ms',
      },
      keyframes: {
        'fade-in': {
          '0%':   { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%':   { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.6' },
        },
      },
      animation: {
        'fade-in':       'fade-in 0.2s ease-out',
        'slide-in-right': 'slide-in-right 0.25s ease-out',
        'pulse-soft':    'pulse-soft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};