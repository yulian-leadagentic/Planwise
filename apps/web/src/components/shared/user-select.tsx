import { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useUsers } from '@/hooks/use-users';
import { UserAvatar } from './user-avatar';
import { useDebounce } from '@/hooks/use-debounce';
import { cn } from '@/lib/utils';

interface UserSelectProps {
  value?: number | null;
  onChange: (userId: number | null) => void;
  placeholder?: string;
  userType?: string;
  className?: string;
}

export function UserSelect({
  value,
  onChange,
  placeholder = 'Select user',
  userType,
  className,
}: UserSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useUsers({ search: debouncedSearch, userType, perPage: 50 });
  const users = data?.data ?? [];

  const selected = users.find((u) => u.id === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className={cn('relative', className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
      >
        {selected ? (
          <>
            <UserAvatar
              firstName={selected.firstName}
              lastName={selected.lastName}
              avatarUrl={selected.avatarUrl}
              size="xs"
            />
            <span>
              {selected.firstName} {selected.lastName}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {value && (
            <X
              className="h-4 w-4 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          )}
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </div>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {users.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No users found</p>
            ) : (
              users.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => {
                    onChange(user.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent',
                    user.id === value && 'bg-accent',
                  )}
                >
                  <UserAvatar
                    firstName={user.firstName}
                    lastName={user.lastName}
                    avatarUrl={user.avatarUrl}
                    size="xs"
                  />
                  <span>
                    {user.firstName} {user.lastName}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
