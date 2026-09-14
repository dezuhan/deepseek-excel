import { Select as RadixSelect } from 'radix-ui';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@heroicons/react/24/outline';
import { cn } from '@/lib/utils';

function Select({ ...props }) {
  return <RadixSelect.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }) {
  return <RadixSelect.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }) {
  return <RadixSelect.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({ className, size = 'default', children, ...props }) {
  return (
    <RadixSelect.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-2.5 py-1.5 text-xs whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-8 data-[size=sm]:h-6 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
      <RadixSelect.Icon asChild>
        <ChevronDownIcon className="size-3.5 opacity-50" />
      </RadixSelect.Icon>
    </RadixSelect.Trigger>
  );
}

function SelectContent({ className, children, position = 'popper', ...props }) {
  return (
    <RadixSelect.Portal>
      <RadixSelect.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 relative z-50 max-h-(--radix-select-content-available-height) min-w-32 origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md',
          position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <RadixSelect.Viewport
          className={cn(
            'p-1',
            position === 'popper' && 'h-(--radix-select-trigger-height) w-full min-w-(--radix-select-trigger-width) scroll-my-1',
          )}
        >
          {children}
        </RadixSelect.Viewport>
        <SelectScrollDownButton />
      </RadixSelect.Content>
    </RadixSelect.Portal>
  );
}

function SelectLabel({ className, ...props }) {
  return <RadixSelect.Label data-slot="select-label" className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)} {...props} />;
}

function SelectItem({ className, children, ...props }) {
  return (
    <RadixSelect.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-xs outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <RadixSelect.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </RadixSelect.ItemIndicator>
      </span>
      <RadixSelect.ItemText>{children}</RadixSelect.ItemText>
    </RadixSelect.Item>
  );
}

function SelectSeparator({ className, ...props }) {
  return <RadixSelect.Separator data-slot="select-separator" className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)} {...props} />;
}

function SelectScrollUpButton({ className, ...props }) {
  return (
    <RadixSelect.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUpIcon className="size-3.5" />
    </RadixSelect.ScrollUpButton>
  );
}

function SelectScrollDownButton({ className, ...props }) {
  return (
    <RadixSelect.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDownIcon className="size-3.5" />
    </RadixSelect.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
