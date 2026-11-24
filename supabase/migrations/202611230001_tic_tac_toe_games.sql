-- Student Hub: public post games and private message games (Tic-Tac-Toe)
-- Apply this migration in the Supabase SQL Editor before enabling the frontend.

create table if not exists public.tic_tac_toe_games (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('post', 'message')),
  post_id uuid references public.posts(id) on delete cascade,
  conversation_id uuid references public.dm_conversations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  player_x uuid not null references auth.users(id) on delete cascade,
  player_o uuid references auth.users(id) on delete set null,
  board text[] not null default array['','','','','','','','','']::text[],
  current_turn text not null default 'X' check (current_turn in ('X','O')),
  status text not null default 'waiting' check (status in ('waiting','active','won','draw')),
  winner text check (winner in ('X','O')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ttt_scope_target_check check (
    (scope = 'post' and post_id is not null and conversation_id is null)
    or
    (scope = 'message' and conversation_id is not null and post_id is null)
  ),
  constraint ttt_board_length_check check (cardinality(board) = 9)
);

create index if not exists tic_tac_toe_games_post_idx
  on public.tic_tac_toe_games(post_id, created_at desc) where scope = 'post';
create index if not exists tic_tac_toe_games_conversation_idx
  on public.tic_tac_toe_games(conversation_id, created_at desc) where scope = 'message';

alter table public.tic_tac_toe_games enable row level security;

drop policy if exists "Read public games on published posts" on public.tic_tac_toe_games;
create policy "Read public games on published posts"
on public.tic_tac_toe_games for select to anon, authenticated
using (
  scope = 'post'
  and exists (
    select 1 from public.posts p
    where p.id = post_id and p.status = 'published'
  )
);

drop policy if exists "Read private games as conversation members" on public.tic_tac_toe_games;
create policy "Read private games as conversation members"
on public.tic_tac_toe_games for select to authenticated
using (
  scope = 'message'
  and public.is_dm_member(conversation_id)
);

revoke all on public.tic_tac_toe_games from anon, authenticated;
grant select on public.tic_tac_toe_games to anon, authenticated;

create or replace function public.create_tic_tac_toe_game(
  _scope text,
  _post_id uuid default null,
  _conversation_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then raise exception 'Sign in to create a game.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;

  if _scope = 'post' then
    if _post_id is null or _conversation_id is not null then
      raise exception 'Choose a valid post for this public game.';
    end if;
    if not exists (
      select 1 from public.posts p
      where p.id = _post_id and p.status = 'published'
    ) then raise exception 'That post is not available.'; end if;
  elsif _scope = 'message' then
    if _conversation_id is null or _post_id is not null then
      raise exception 'Choose a valid conversation for this private game.';
    end if;
    if not public.is_dm_member(_conversation_id) then
      raise exception 'Only conversation members can create a private game.';
    end if;
  else
    raise exception 'Unsupported game scope.';
  end if;

  insert into public.tic_tac_toe_games(scope, post_id, conversation_id, created_by, player_x)
  values (_scope, _post_id, _conversation_id, v_user, v_user)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.join_tic_tac_toe_game(_game_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_game public.tic_tac_toe_games%rowtype;
begin
  if v_user is null then raise exception 'Sign in to join a game.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;

  select * into v_game
  from public.tic_tac_toe_games
  where id = _game_id
  for update;

  if not found then raise exception 'Game not found.'; end if;
  if v_game.status <> 'waiting' or v_game.player_o is not null then
    raise exception 'This game already has two players or has started.';
  end if;
  if v_game.player_x = v_user then raise exception 'You created this game.'; end if;

  if v_game.scope = 'post' then
    if not exists (
      select 1 from public.posts p
      where p.id = v_game.post_id and p.status = 'published'
    ) then raise exception 'This post is no longer available.'; end if;
  elsif v_game.scope = 'message' then
    if not public.is_dm_member(v_game.conversation_id) then
      raise exception 'Only conversation members can join this private game.';
    end if;
  end if;

  update public.tic_tac_toe_games
  set player_o = v_user, status = 'active', updated_at = now()
  where id = _game_id;
  return _game_id;
end;
$$;

create or replace function public.make_tic_tac_toe_move(_game_id uuid, _cell integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_game public.tic_tac_toe_games%rowtype;
  v_mark text;
  v_board text[];
  v_winner text := null;
  v_line integer[][];
  v_i integer;
begin
  if v_user is null then raise exception 'Sign in to play.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  if _cell < 0 or _cell > 8 then raise exception 'Choose a valid square.'; end if;

  select * into v_game
  from public.tic_tac_toe_games
  where id = _game_id
  for update;

  if not found then raise exception 'Game not found.'; end if;
  if v_game.status <> 'active' then raise exception 'This game is not active.'; end if;
  if v_game.scope = 'message' and not public.is_dm_member(v_game.conversation_id) then
    raise exception 'Only conversation members can access this game.';
  elsif v_game.scope = 'post' and not exists (
    select 1 from public.posts p
    where p.id = v_game.post_id and p.status = 'published'
  ) then
    raise exception 'This post is no longer available.';
  end if;

  v_mark := case
    when v_user = v_game.player_x then 'X'
    when v_user = v_game.player_o then 'O'
    else null
  end;
  if v_mark is null then raise exception 'You are not a player in this game.'; end if;
  if v_mark <> v_game.current_turn then raise exception 'It is not your turn.'; end if;

  v_board := v_game.board;
  if v_board[_cell + 1] <> '' then raise exception 'That square is already taken.'; end if;
  v_board[_cell + 1] := v_mark;

  v_line := array[
    array[1,2,3], array[4,5,6], array[7,8,9],
    array[1,4,7], array[2,5,8], array[3,6,9],
    array[1,5,9], array[3,5,7]
  ];
  for v_i in 1..8 loop
    if v_board[v_line[v_i][1]] = v_mark
      and v_board[v_line[v_i][2]] = v_mark
      and v_board[v_line[v_i][3]] = v_mark then
      v_winner := v_mark;
      exit;
    end if;
  end loop;

  update public.tic_tac_toe_games
  set board = v_board,
      current_turn = case when v_mark = 'X' then 'O' else 'X' end,
      status = case
        when v_winner is not null then 'won'
        when array_position(v_board, '') is null then 'draw'
        else 'active'
      end,
      winner = v_winner,
      updated_at = now()
  where id = _game_id;
  return _game_id;
end;
$$;

revoke all on function public.create_tic_tac_toe_game(text, uuid, uuid) from public;
revoke all on function public.join_tic_tac_toe_game(uuid) from public;
revoke all on function public.make_tic_tac_toe_move(uuid, integer) from public;
grant execute on function public.create_tic_tac_toe_game(text, uuid, uuid) to authenticated;
grant execute on function public.join_tic_tac_toe_game(uuid) to authenticated;
grant execute on function public.make_tic_tac_toe_move(uuid, integer) to authenticated;
