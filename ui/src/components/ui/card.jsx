import { cn } from '@/lib/utils';

function Card({ className, ...props }) {
  return (
    <div
      data-slot="card"
      className={cn('bg-card text-card-foreground flex flex-col gap-3 rounded-xl border py-3 shadow-sm', className)}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1 px-3', className)} {...props} />;
}

function CardTitle({ className, ...props }) {
  return <div data-slot="card-title" className={cn('text-sm leading-none font-semibold', className)} {...props} />;
}

function CardDescription({ className, ...props }) {
  return <div data-slot="card-description" className={cn('text-muted-foreground text-xs', className)} {...props} />;
}

function CardContent({ className, ...props }) {
  return <div data-slot="card-content" className={cn('px-3', className)} {...props} />;
}

function CardFooter({ className, ...props }) {
  return <div data-slot="card-footer" className={cn('flex items-center px-3', className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
