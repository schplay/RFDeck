import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { PinGate } from './components/PinGate';
import './styles/index.css';

// PinGate is a no-op on the default open configuration and on the machine
// running RFDeck; it only prompts remote clients when an admin enabled a PIN.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PinGate>
      <RouterProvider router={router} />
    </PinGate>
  </StrictMode>,
);
