import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { icons } from '@/lib/icons';

/**
 * Minimal Gemini-like header: menu (chat history), title, new chat, settings.
 * Model, reasoning effort and language all live in the settings dialog.
 */
export default function Header({ t, state, onToggleHistory, onNewChat, onOpenSettings }) {
  const MenuIcon = icons.menu;
  const NewChatIcon = icons.newChat;
  const SettingsIcon = icons.settings;

  return (
    <header className="bg-background flex items-center justify-between gap-1 border-b px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('header.history')}
            onClick={() => onToggleHistory()}
          >
            <MenuIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('header.history')}</TooltipContent>
      </Tooltip>

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium" title={t('app.project')}>
          {t('app.name')}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('header.newChat')} onClick={onNewChat}>
              <NewChatIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('header.newChat')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('settings.title')} onClick={onOpenSettings}>
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('settings.title')}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
