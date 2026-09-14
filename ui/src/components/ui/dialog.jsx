import { Dialog as RadixDialog } from 'radix-ui';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { cn } from '@/lib/utils';

function Dialog({ ...props }) {
  return <RadixDialog.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }) {
  return <RadixDialog.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }) {
  return <RadixDialog.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }) {
  return <RadixDialog.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }) {
  return (
    <RadixDialog.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({ className, children, showCloseButton = true, ...props }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <RadixDialog.Content
        data-slot="dialog-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-1.5rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border p-4 shadow-lg duration-200',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <RadixDialog.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring absolute top-3 right-3 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none"
          >
            <XMarkIcon className="size-4" />
            <span className="sr-only">Close</span>
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />;
}

function DialogFooter({ className, ...props }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }) {
  return <RadixDialog.Title data-slot="dialog-title" className={cn('text-sm leading-none font-semibold', className)} {...props} />;
}

function DialogDescription({ className, ...props }) {
  return (
    <RadixDialog.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-xs', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
