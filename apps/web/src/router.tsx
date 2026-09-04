import { createHashRouter } from 'react-router-dom';
import RootLayout from './layouts/RootLayout';
import MonitoringDashboard from './pages/monitoring/MonitoringDashboard';
import InventoryManager from './pages/inventory/InventoryManager';
import RFScanner from './pages/rf/RFScanner';
import BatteryDashboard from './pages/battery/BatteryDashboard';
import Settings from './pages/settings/Settings';
import BackstageView from './pages/backstage/BackstageView';
import MicboardView from './pages/micboard/MicboardView';
import ShowManagement from './pages/shows/ShowManagement';
import PerformersPage from './pages/performers/PerformersPage';
import DetectionsPage from './pages/detections/DetectionsPage';
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
  // Full-screen wall display, no sidebar. Read-only and PIN-exempt, so a
  // screen backstage can be pointed at this URL and left alone.
  {
    path: '/micboard',
    element: guard('Micboard', <MicboardView />)
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
      },
      {
        path: 'performers',
        element: guard('Performers', <PerformersPage />)
      },
      {
        path: 'detections',
        element: guard('Detections', <DetectionsPage />)
      }
    ]
  }
]);
