import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppRouter } from './router/app-router';
import { AuthBootstrap } from './router/auth-bootstrap';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthBootstrap>
          <AppRouter />
        </AuthBootstrap>
        {/*
         * All notifications render through notify.tsx as toast.custom
         * cards, so we drop `richColors` (it adds Sonner's default
         * coloring that fights our own) and `closeButton` (our card
         * has its own dismiss X). `visibleToasts={5}` caps the
         * stack — newer ones push out the oldest so the screen
         * doesn't fill up during long error sequences.
         */}
        <Toaster
          position="top-right"
          visibleToasts={5}
          toastOptions={{ unstyled: true, className: '' }}
        />
      </BrowserRouter>
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
