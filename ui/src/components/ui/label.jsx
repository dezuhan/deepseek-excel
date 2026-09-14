import { Label as RadixLabel } from 'radix-ui';
import { cn } from '@/lib/utils';

function Label({ className, ...props }) {
  return (
    <RadixLabel.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-xs leading-none font-medium select-none',
        'group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50',
        'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
