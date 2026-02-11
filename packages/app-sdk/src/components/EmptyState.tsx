import React from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: string;
  className?: string;
}

export function EmptyState({ title, description, icon, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 text-center ${className}`}>
      {icon && <span className="text-4xl mb-4">{icon}</span>}
      <h3 className="text-base font-medium text-foreground/85">{title}</h3>
      {description && <p className="mt-2 text-sm text-foreground/60">{description}</p>}
    </div>
  );
}
