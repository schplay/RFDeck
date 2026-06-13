import React from 'react';
import './Card.css';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'glass';
  statusBorder?: 'success' | 'warning' | 'error' | 'default';
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', variant = 'default', statusBorder = 'default', children, ...props }, ref) => {
    const classes = [
      'rfdeck-card',
      `rfdeck-card-${variant}`,
      statusBorder !== 'default' ? `rfdeck-card-border-${statusBorder}` : '',
      className,
    ].filter(Boolean).join(' ');

    return (
      <div ref={ref} className={classes} {...props}>
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';
