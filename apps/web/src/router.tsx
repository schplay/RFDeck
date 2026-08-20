import { createHashRouter } from 'react-router-dom';
import RootLayout from './layouts/RootLayout';
import MonitoringDashboard from './pages/monitoring/MonitoringDashboard';
import InventoryManager from './pages/inventory/InventoryManager';
import RFScanner from './pages/rf/RFScanner';
import BatteryDashboard from './pages/battery/BatteryDashboard';
import Settings from './pages/settings/Settings';
import BackstageView from './pages/backstage/BackstageView';
import ShowManagement from './pages/shows/ShowManagement';
import { ErrorBoundary } from './components/ErrorBoundary';

// Each route is wrapped so a render error takes down one page, not the whole
// application. Mid-show an unhandled error used to mean a black window.
const guard = (label: string, element: React.ReactNode) => (
  <ErrorBoundary label={label} variant="page">{element}</ErrorBoundary>
);

export const router = createHashRouter([
  // Backstage/Talent view — full-screen, no sidebar
  {
    path: '/backstage',
    element: guard('Backstage view', <BackstageView />)
  },
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: guard('Monitoring Dashboard', <MonitoringDashboard />)
      },
      {
        path: 'inventory',
        element: guard('Hardware Inventory', <InventoryManager />)
      },
      {
        path: 'rf',
        element: guard('RF Environment', <RFScanner />)
      },
      {
        path: 'battery',
        element: guard('Battery Management', <BatteryDashboard />)
      },
      {
        path: 'settings',
        element: guard('Settings', <Settings />)
      },
      {
        path: 'shows',
        element: guard('Show & Mic Check', <ShowManagement />)
      }
    ]
  }
]);
