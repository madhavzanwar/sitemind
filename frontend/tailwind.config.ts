import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: {
          950: '#06080C',
          900: '#0A0D13',
          850: '#0E121A',
          800: '#121722',
          700: '#1A2130',
          600: '#252E40',
          500: '#3A4558',
          400: '#5C687D',
          300: '#8A95A8',
          200: '#B7C0CF',
          100: '#DDE3EC',
          50: '#F2F5F9',
        },
        accent: {
          DEFAULT: '#FFB224',
          50: '#FFF7E6',
          100: '#FFEBC2',
          200: '#FFD98A',
          300: '#FFC757',
          400: '#FFB224',
          500: '#F59E0B',
          600: '#C77A06',
          700: '#8F5604',
        },
      },
      boxShadow: {
        card: '0 0 0 1px rgba(255,255,255,0.045), 0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(255,178,36,0.35), 0 0 24px -4px rgba(255,178,36,0.35)',
        danger: '0 0 0 1px rgba(244,63,94,0.45), 0 0 32px -6px rgba(244,63,94,0.55)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        'slide-in': { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'none' } },
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(255,178,36,0.5)' },
          '70%': { boxShadow: '0 0 0 8px rgba(255,178,36,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(255,178,36,0)' },
        },
        scan: { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(100%)' } },
        dash: { to: { strokeDashoffset: '-20' } },
      },
      animation: {
        'fade-up': 'fade-up .35s cubic-bezier(.2,.8,.2,1) both',
        'slide-in': 'slide-in .4s cubic-bezier(.2,.8,.2,1) both',
        'pulse-ring': 'pulseRing 1.6s ease-out infinite',
        scan: 'scan 2.2s linear infinite',
        dash: 'dash 1s linear infinite',
      },
    },
  },
  plugins: [],
} satisfies Config
