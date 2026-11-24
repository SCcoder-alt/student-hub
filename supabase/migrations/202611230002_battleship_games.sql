-- Student Hub: classic private Battleship for direct and group DMs.
-- Fleet layouts are never directly selectable; all reads go through a sanitized RPC.

create table if not exists public.battleship_games (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.dm_conversations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  player_one uuid not null references auth.users(id) on delete cascade,
  player_two uuid references auth.users(id) on delete set null,
  fleet_one jsonb,
  fleet_two jsonb,
  shots_one integer[] not null default '{}'::integer[],
  shots_two integer[] not null default '{}'::integer[],
  current_turn uuid references auth.users(id) on delete set null,
  status text not null default 'waiting' check (status in ('waiting','placing','active','won')),
  winner uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists battleship_games_conversation_idx
  on public.battleship_games(conversation_id, created_at desc);

alter table public.battleship_games enable row level security;
revoke all on public.battleship_games from anon, authenticated;

create or replace function public.create_battleship_game(_conversation_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'Sign in to create a game.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  if not public.is_dm_member(_conversation_id) then raise exception 'Only conversation members can create a game.'; end if;
  insert into public.battleship_games(conversation_id,created_by,player_one)
  values (_conversation_id,v_user,v_user) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.join_battleship_game(_game_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_user uuid := auth.uid(); v_game public.battleship_games%rowtype;
begin
  if v_user is null then raise exception 'Sign in to join a game.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  select * into v_game from public.battleship_games where id=_game_id for update;
  if not found then raise exception 'Game not found.'; end if;
  if not public.is_dm_member(v_game.conversation_id) then raise exception 'Only conversation members can join.'; end if;
  if v_game.status <> 'waiting' or v_game.player_two is not null then raise exception 'This game is no longer waiting.'; end if;
  if v_game.player_one = v_user then raise exception 'You created this challenge.'; end if;
  update public.battleship_games set player_two=v_user,status='placing',updated_at=now() where id=_game_id;
  return _game_id;
end;
$$;

create or replace function public.place_battleship_fleet(_game_id uuid,_fleet jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_game public.battleship_games%rowtype;
  v_ship jsonb;
  v_name text;
  v_cells integer[];
  v_all integer[] := '{}'::integer[];
  v_expected integer;
  v_min integer;
  v_max integer;
  v_first integer;
  v_same_row boolean;
  v_same_col boolean;
  v_names text[] := '{}'::text[];
begin
  if v_user is null then raise exception 'Sign in to place ships.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  select * into v_game from public.battleship_games where id=_game_id for update;
  if not found then raise exception 'Game not found.'; end if;
  if v_game.status not in ('placing','active') then raise exception 'This game is not accepting fleet placements.'; end if;
  if v_user not in (v_game.player_one,v_game.player_two) then raise exception 'You are not a player in this game.'; end if;
  if jsonb_typeof(_fleet) <> 'array' or jsonb_array_length(_fleet) <> 5 then raise exception 'Place all five ships.'; end if;

  for v_ship in select value from jsonb_array_elements(_fleet)
  loop
    v_name := v_ship->>'name';
    v_expected := case v_name when 'Carrier' then 5 when 'Battleship' then 4 when 'Cruiser' then 3 when 'Submarine' then 3 when 'Destroyer' then 2 else 0 end;
    if v_expected=0 or v_name=any(v_names) then raise exception 'Fleet contains an invalid or duplicate ship.'; end if;
    v_names := array_append(v_names,v_name);
    if jsonb_typeof(v_ship->'cells') <> 'array' or jsonb_array_length(v_ship->'cells') <> v_expected then
      raise exception '% must occupy % squares.',v_name,v_expected;
    end if;
    select array_agg(value::integer order by ordinality) into v_cells
      from jsonb_array_elements_text(v_ship->'cells') with ordinality;
    if exists (select 1 from unnest(v_cells) c where c < 0 or c > 99) then raise exception 'Ship placement is outside the board.'; end if;
    if (select count(distinct c) from unnest(v_cells) c) <> v_expected then raise exception 'A ship cannot overlap itself.'; end if;
    if v_cells && v_all then raise exception 'Ships cannot overlap.'; end if;
    v_first := v_cells[1];
    v_same_row := (select bool_and((c / 10) = (v_first / 10)) from unnest(v_cells) c);
    v_same_col := (select bool_and((c % 10) = (v_first % 10)) from unnest(v_cells) c);
    select min(c),max(c) into v_min,v_max from unnest(v_cells) c;
    if not ((v_same_row and v_max-v_min=v_expected-1) or (v_same_col and v_max-v_min=10*(v_expected-1))) then
      raise exception '% must be in one straight, unbroken line.',v_name;
    end if;
    v_all := v_all || v_cells;
  end loop;
  if cardinality(v_all) <> 17 then raise exception 'Fleet must contain exactly 17 ship squares.'; end if;

  if v_user=v_game.player_one then
    update public.battleship_games set fleet_one=_fleet,updated_at=now() where id=_game_id;
  else
    update public.battleship_games set fleet_two=_fleet,updated_at=now() where id=_game_id;
  end if;

  select * into v_game from public.battleship_games where id=_game_id;
  if v_game.fleet_one is not null and v_game.fleet_two is not null then
    update public.battleship_games set status='active',current_turn=coalesce(current_turn,player_one),updated_at=now() where id=_game_id;
  end if;
end;
$$;

create or replace function public.attack_battleship(_game_id uuid,_cell integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_game public.battleship_games%rowtype;
  v_target_fleet jsonb;
  v_shots integer[];
  v_ship jsonb;
  v_all_cells integer[] := '{}'::integer[];
  v_hit_count integer;
begin
  if v_user is null then raise exception 'Sign in to play.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  if _cell < 0 or _cell > 99 then raise exception 'Choose a valid square.'; end if;
  select * into v_game from public.battleship_games where id=_game_id for update;
  if not found then raise exception 'Game not found.'; end if;
  if not public.is_dm_member(v_game.conversation_id) then raise exception 'Only conversation members can play.'; end if;
  if v_game.status <> 'active' then raise exception 'Both fleets must be placed before battle starts.'; end if;
  if v_game.current_turn <> v_user then raise exception 'It is not your turn.'; end if;

  if v_user=v_game.player_one then
    v_shots:=v_game.shots_one; v_target_fleet:=v_game.fleet_two;
  elsif v_user=v_game.player_two then
    v_shots:=v_game.shots_two; v_target_fleet:=v_game.fleet_one;
  else raise exception 'You are not a player in this game.';
  end if;
  if _cell=any(v_shots) then raise exception 'You already fired at that coordinate.'; end if;

  for v_ship in select value from jsonb_array_elements(v_target_fleet) loop
    select v_all_cells || array_agg(value::integer) into v_all_cells
      from jsonb_array_elements_text(v_ship->'cells');
  end loop;
  v_shots:=array_append(v_shots,_cell);
  select count(*) into v_hit_count from unnest(v_shots) c where c=any(v_all_cells);

  if v_user=v_game.player_one then
    update public.battleship_games set shots_one=v_shots,
      status=case when v_hit_count=17 then 'won' else 'active' end,
      winner=case when v_hit_count=17 then v_user else null end,
      current_turn=case when v_hit_count=17 then v_user else player_two end,updated_at=now()
      where id=_game_id;
  else
    update public.battleship_games set shots_two=v_shots,
      status=case when v_hit_count=17 then 'won' else 'active' end,
      winner=case when v_hit_count=17 then v_user else null end,
      current_turn=case when v_hit_count=17 then v_user else player_one end,updated_at=now()
      where id=_game_id;
  end if;
end;
$$;

create or replace function public.list_battleship_games(_conversation_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_dm_member(_conversation_id) then raise exception 'Conversation access required.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',g.id,'created_by',g.created_by,'player_one',g.player_one,'player_two',g.player_two,
      'status',g.status,'current_turn',g.current_turn,'winner',g.winner,'created_at',g.created_at
    ) order by g.created_at desc)
    from public.battleship_games g where g.conversation_id=_conversation_id
  ),'[]'::jsonb);
end;
$$;

create or replace function public.get_battleship_state(_game_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_game public.battleship_games%rowtype; v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Sign in to view this game.'; end if;
  select * into v_game from public.battleship_games where id=_game_id;
  if not found or not public.is_dm_member(v_game.conversation_id) then raise exception 'Game not found.'; end if;
  if v_user not in (v_game.player_one,v_game.player_two) then raise exception 'You are not a player in this game.'; end if;
  return jsonb_build_object(
    'id',v_game.id,'player_one',v_game.player_one,'player_two',v_game.player_two,
    'status',v_game.status,'current_turn',v_game.current_turn,'winner',v_game.winner,
    'own_fleet',case when v_user=v_game.player_one then v_game.fleet_one else v_game.fleet_two end,
    'shots_fired',case when v_user=v_game.player_one then v_game.shots_one else v_game.shots_two end,
    'shots_received',case when v_user=v_game.player_one then v_game.shots_two else v_game.shots_one end
  );
end;
$$;

revoke all on function public.create_battleship_game(uuid) from public;
revoke all on function public.join_battleship_game(uuid) from public;
revoke all on function public.place_battleship_fleet(uuid,jsonb) from public;
revoke all on function public.attack_battleship(uuid,integer) from public;
revoke all on function public.list_battleship_games(uuid) from public;
revoke all on function public.get_battleship_state(uuid) from public;
grant execute on function public.create_battleship_game(uuid) to authenticated;
grant execute on function public.join_battleship_game(uuid) to authenticated;
grant execute on function public.place_battleship_fleet(uuid,jsonb) to authenticated;
grant execute on function public.attack_battleship(uuid,integer) to authenticated;
grant execute on function public.list_battleship_games(uuid) to authenticated;
grant execute on function public.get_battleship_state(uuid) to authenticated;
