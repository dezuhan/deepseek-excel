import { Tooltip as RadixTooltip } from 'radix-ui';
import { cn } from '@/lib/utils';

function TooltipProvider({ delayDuration = 200, ...props }) {
  return <RadixTooltip.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }) {
  return (
    <TooltipProvider>
      <RadixTooltip.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({ ...props }) {
  return <RadixTooltip.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({ className, sideOffset = 4, children, ...props }) {
  return (
    <RadixTooltip.Portal>
      <RadixTooltip.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 z-50 w-fit max-w-64 rounded-md px-2 py-1 text-xs text-balance',
          className,
        )}
        {...props}
      >
        {children}
        <RadixTooltip.Arrow className="bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
