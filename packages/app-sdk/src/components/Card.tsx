import React from 'react';

export interface CardProps {
  children: React.ReactNode;
  title?: string;
  className?: string;
}

export function Card({ children, title, className = '' }: CardProps) {
  return (
    <div className={`rounded-md border border-foreground/10 bg-background p-4 shadow-sm ${className}`}>
      {title && <h3 className="text-sm font-medium mb-2">{title}</h3>}
      {children}
    </div>
  );
}
