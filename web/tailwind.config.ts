import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        accent: '#C8FF00',
        surface: '#111111',
        's2': '#171717',
        border: '#222222',
        muted: '#4A4A4A',
        'c-red': '#FF3030',
        'c-green': '#00FF6A',
        'c-amber': '#FF9500',
      },
      fontFamily: {
        display: ['var(--font-bebas)'],
        mono:    ['var(--font-jetbrains)'],
        body:    ['var(--font-syne)'],
      },
      keyframes: {
        'flash-green': {
          '0%,100%': { background: 'transparent' },
          '20%':     { background: 'rgba(0,255,106,0.22)' },
        },
        'flash-red': {
          '0%,100%': { background: 'transparent' },
          '20%':     { background: 'rgba(255,48,48,0.22)' },
        },
        'flash-amber': {
          '0%,100%': { background: 'transparent' },
          '20%':     { background: 'rgba(255,149,0,0.22)' },
        },
        'slide-in': {
          from: { transform: 'translateX(110%)', opacity: '0' },
          to:   { transform: 'translateX(0)',    opacity: '1' },
        },
        'fade-out': {
          from: { opacity: '1' },
          to:   { opacity: '0' },
        },
        'pulse-dot': {
          '0%,100%': { opacity: '1', transform: 'scale(1)' },
          '50%':     { opacity: '0.3', transform: 'scale(0.7)' },
        },
        'count-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'flash-green':  'flash-green 1.2s ease-out',
        'flash-red':    'flash-red 1.2s ease-out',
        'flash-amber':  'flash-amber 1.2s ease-out',
        'slide-in':     'slide-in 0.35s cubic-bezier(0.16,1,0.3,1)',
        'fade-out':     'fade-out 0.3s ease forwards',
        'pulse-dot':    'pulse-dot 1.4s ease-in-out infinite',
        'count-up':     'count-up 0.25s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
