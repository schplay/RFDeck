import { createHashRouter } from 'react-router-dom';
import RootLayout from './layouts/RootLayout';
import MonitoringDashboard from './pages/monitoring/MonitoringDashboard';
import InventoryManager from './pages/inventory/InventoryManager';
import RFScanner from './pages/rf/RFScanner';
import BatteryDashboard from './pages/battery/BatteryDashboard';
import Settings from './pages/settings/Settings';
import BackstageView from './pages/backstage/BackstageView';
import ShowManagement from './pages/shows/ShowManagement';

export const router = createHashRouter([
  // Backstage/Talent view — full-screen, no sidebar
  {
    path: '/backstage',
    element: <BackstageView />
  },
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <MonitoringDashboard />
      },
      {
        path: 'inventory',
        element: <InventoryManager />
      },
      {
        path: 'rf',
        element: <RFScanner />
      },
      {
        path: 'battery',
        element: <BatteryDashboard />
      },
      {
        path: 'settings',
        element: <Settings />
      },
      {
        path: 'shows',
        element: <ShowManagement />
      }
    ]
  }
]);

