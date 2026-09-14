import { ScrollArea as RadixScrollArea } from 'radix-ui';
import { cn } from '@/lib/utils';

function ScrollBar({ className, orientation = 'vertical', ...props }) {
  return (
    <RadixScrollArea.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <RadixScrollArea.Thumb data-slot="scroll-area-thumb" className="bg-border relative flex-1 rounded-full" />
    </RadixScrollArea.Scrollbar>
  );
}

function ScrollArea({ className, children, ...props }) {
  return (
    <RadixScrollArea.Root data-slot="scroll-area" className={cn('relative', className)} {...props}>
      <RadixScrollArea.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </RadixScrollArea.Viewport>
      <ScrollBar />
      <RadixScrollArea.Corner />
    </RadixScrollArea.Root>
  );
}

export { ScrollArea, ScrollBar };
