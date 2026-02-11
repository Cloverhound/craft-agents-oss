import React from 'react';

export interface BadgeProps {
  text: string;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}

const variantClasses: Record<string, string> = {
  default: 'bg-foreground/8 text-foreground/75',
  success: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  warning: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
  danger: 'bg-destructive/12 text-destructive',
  info: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
};

export function Badge({ text, variant = 'default' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${variantClasses[variant]}`}>
      {text}
    </span>
  );
}
