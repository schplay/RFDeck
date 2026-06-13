import React, { useState } from 'react';
import { useAlertStore } from '../../stores/alertStore';
import { Bell, X, AlertTriangle, AlertCircle, Info, Trash2 } from 'lucide-react';
import './AlertFeed.css';

export function AlertFeed() {
  const [isOpen, setIsOpen] = useState(false);
  const { alerts, dismissAlert, clearAll } = useAlertStore();

  const unreadCount = alerts.filter(a => !a.dismissed).length;
  const visibleAlerts = alerts.filter(a => !a.dismissed);

  const getIcon = (severity: string) => {
    switch (severity) {
      case 'CRITICAL': return <AlertCircle size={16} className="text-error" />;
      case 'WARNING': return <AlertTriangle size={16} className="text-warning" />;
      default: return <Info size={16} className="text-info" />;
    }
  };

  return (
    <>
      <button className="alert-bell-btn" onClick={() => setIsOpen(true)}>
        <Bell size={20} />
        {unreadCount > 0 && <span className="alert-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {isOpen && (
        <>
          <div className="alert-backdrop" onClick={() => setIsOpen(false)} />
          <div className="alert-drawer">
            <div className="alert-drawer-header">
              <div className="alert-drawer-title">
                <Bell size={18} />
                <h3>Alerts</h3>
              </div>
              <div className="alert-drawer-actions">
                <button onClick={clearAll} className="clear-btn" title="Clear all">
                  <Trash2 size={16} />
                </button>
                <button onClick={() => setIsOpen(false)} className="close-btn">
                  <X size={20} />
                </button>
              </div>
            </div>

            <div className="alert-drawer-content">
              {visibleAlerts.length === 0 ? (
                <div className="empty-alerts">No active alerts.</div>
              ) : (
                visibleAlerts.map(alert => (
                  <div key={alert.id} className={`alert-card severity-${alert.severity.toLowerCase()}`}>
                    <div className="alert-card-icon">
                      {getIcon(alert.severity)}
                    </div>
                    <div className="alert-card-body">
                      <div className="alert-card-header">
                        <span className="alert-type">{alert.type.replace('_', ' ')}</span>
                        <span className="alert-time">
                          {new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </div>
                      <div className="alert-message">{alert.message}</div>
                      {(alert.channelName || alert.deviceName) && (
                        <div className="alert-context">
                          {alert.channelName && <span className="channel-badge">{alert.channelName}</span>}
                          {alert.deviceName && <span className="device-badge">{alert.deviceName}</span>}
                        </div>
                      )}
                    </div>
                    <button className="dismiss-btn" onClick={() => dismissAlert(alert.id)}>
                      <X size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
