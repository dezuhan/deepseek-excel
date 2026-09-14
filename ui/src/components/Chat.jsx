import Markdown from '@/components/Markdown';
import { icons } from '@/lib/icons';
import { cn } from '@/lib/utils';
import PlanCard from '@/components/PlanCard';

/** Minimal, heading-free suggestions (Gemini-style single rows, hidden once a chat starts). */
const SUGGESTIONS = ['quick.analysis', 'quick.summary', 'quick.format'];

function Suggestions({ t, disabled, onSelect }) {
  const SuggestionIcon = icons.suggestion;
  return (
    <ul className="flex flex-col gap-0.5">
      {SUGGESTIONS.map((key) => (
        <li key={key}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSelect(t(`${key}.prompt`))}
            className="hover:bg-accent/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs disabled:opacity-50"
          >
            <SuggestionIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{t(`${key}.label`)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MessageItem({ item, t }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-primary text-primary-foreground max-w-[88%] rounded-2xl px-3 py-2 text-xs">
          <Markdown
            className="md-invert"
            text={item.text}
            copyLabel={t('msg.copy')}
            copiedLabel={t('msg.copied')}
          />
        </div>
      </div>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[95%] px-1 py-0.5 text-xs leading-relaxed">
          <Markdown text={item.text} copyLabel={t('msg.copy')} copiedLabel={t('msg.copied')} />
        </div>
      </div>
    );
  }

  if (item.kind === 'system') {
    return <div className="text-muted-foreground px-1 text-[11px] italic">{item.text}</div>;
  }

  if (item.kind === 'error') {
    return (
      <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-2 py-1.5 text-[11px]">
        {item.text}
      </div>
    );
  }

  if (item.kind === 'reasoning') {
    return (
      <details className="text-muted-foreground text-[11px]">
        <summary className="cursor-pointer">{t('msg.reasoning')}</summary>
        <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-2 whitespace-pre-wrap">{item.text}</pre>
      </details>
    );
  }

  const Icon = icons[item.icon] || icons.toolCall;
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 font-mono text-[11px]',
        item.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{item.text}</span>
    </div>
  );
}

export default function Chat({ t, state, disabled, onDecide, onApplyAll, onSuggest }) {
  const { timeline, plans } = state;
  const isEmpty = !timeline.length && !plans.length;

  if (isEmpty) {
    // No greeting text: just the suggestions, like a fresh Gemini sidebar.
    return <Suggestions t={t} disabled={disabled} onSelect={onSuggest} />;
  }

  return (
    <>
      {timeline.map((item) => (
        <MessageItem key={item.id} item={item} t={t} />
      ))}
      {plans.map((plan) => (
        <PlanCard
          key={plan.id}
          plan={plan}
          t={t}
          onDecide={onDecide}
          showApplyAll={plans.length > 1}
          onApplyAll={onApplyAll}
        />
      ))}
    </>
  );
}
