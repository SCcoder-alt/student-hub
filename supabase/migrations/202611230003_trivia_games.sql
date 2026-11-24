-- Student Hub: creator-authored multiplayer Trivia.
-- Apply this migration in the Supabase SQL Editor before using Trivia.

create table if not exists public.trivia_games (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('post','message')),
  post_id uuid references public.posts(id) on delete cascade,
  conversation_id uuid references public.dm_conversations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Trivia Challenge' check (char_length(title) between 1 and 60),
  status text not null default 'waiting' check (status in ('waiting','active','completed')),
  current_question integer not null default 1 check (current_question >= 1),
  question_seconds integer not null default 15 check (question_seconds between 5 and 60),
  question_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trivia_scope_target_check check (
    (scope='post' and post_id is not null and conversation_id is null)
    or (scope='message' and conversation_id is not null and post_id is null)
  )
);

create table if not exists public.trivia_questions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.trivia_games(id) on delete cascade,
  position integer not null check (position between 1 and 30),
  prompt text not null check (char_length(prompt) between 1 and 300),
  choices jsonb not null,
  correct_index integer not null check (correct_index between 0 and 3),
  created_at timestamptz not null default now(),
  unique(game_id,position),
  constraint trivia_choices_check check (
    jsonb_typeof(choices)='array'
    and jsonb_array_length(choices) between 2 and 4
  )
);

create table if not exists public.trivia_players (
  game_id uuid not null references public.trivia_games(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  score integer not null default 0 check (score >= 0),
  joined_at timestamptz not null default now(),
  primary key(game_id,user_id)
);

create table if not exists public.trivia_answers (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.trivia_games(id) on delete cascade,
  question_id uuid not null references public.trivia_questions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  choice_index integer not null check (choice_index between 0 and 3),
  is_correct boolean not null,
  answered_at timestamptz not null default now(),
  unique(question_id,user_id)
);

create index if not exists trivia_games_post_idx on public.trivia_games(post_id,created_at desc) where scope='post';
create index if not exists trivia_games_conversation_idx on public.trivia_games(conversation_id,created_at desc) where scope='message';
create index if not exists trivia_questions_game_idx on public.trivia_questions(game_id,position);
create index if not exists trivia_answers_game_idx on public.trivia_answers(game_id,question_id);

alter table public.trivia_games enable row level security;
alter table public.trivia_questions enable row level security;
alter table public.trivia_players enable row level security;
alter table public.trivia_answers enable row level security;
revoke all on public.trivia_games,public.trivia_questions,public.trivia_players,public.trivia_answers from anon,authenticated;

create or replace function public.create_trivia_game(
  _scope text,
  _post_id uuid default null,
  _conversation_id uuid default null,
  _title text default 'Trivia Challenge'
)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_id uuid; v_title text:=btrim(coalesce(_title,'Trivia Challenge'));
begin
  if v_user is null then raise exception 'Sign in to create a trivia game.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  if char_length(v_title)<1 or char_length(v_title)>60 then raise exception 'Game title must be 1–60 characters.'; end if;
  if _scope='post' then
    if _post_id is null or _conversation_id is not null then raise exception 'Choose a valid post.'; end if;
    if not exists(select 1 from public.posts where id=_post_id and status='published') then raise exception 'That post is not available.'; end if;
  elsif _scope='message' then
    if _conversation_id is null or _post_id is not null then raise exception 'Choose a valid conversation.'; end if;
    if not public.is_dm_member(_conversation_id) then raise exception 'Only conversation members can create a game.'; end if;
  else raise exception 'Unsupported game location.'; end if;

  insert into public.trivia_games(scope,post_id,conversation_id,created_by,title)
  values(_scope,_post_id,_conversation_id,v_user,v_title) returning id into v_id;
  insert into public.trivia_players(game_id,user_id) values(v_id,v_user);
  return v_id;
end;
$$;

create or replace function public.join_trivia_game(_game_id uuid)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_game public.trivia_games%rowtype; v_count integer;
begin
  if v_user is null then raise exception 'Sign in to join Trivia.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  select * into v_game from public.trivia_games where id=_game_id for update;
  if not found then raise exception 'Game not found.'; end if;
  if v_game.status<>'waiting' then raise exception 'This game has already started.'; end if;
  if v_game.scope='post' then
    if not exists(select 1 from public.posts where id=v_game.post_id and status='published') then raise exception 'This post is no longer available.'; end if;
  elsif not public.is_dm_member(v_game.conversation_id) then raise exception 'Only conversation members can join.'; end if;
  select count(*) into v_count from public.trivia_players where game_id=_game_id;
  if v_count>=12 and not exists(select 1 from public.trivia_players where game_id=_game_id and user_id=v_user) then
    raise exception 'This Trivia game is full (12 players).';
  end if;
  insert into public.trivia_players(game_id,user_id) values(_game_id,v_user) on conflict do nothing;
  return _game_id;
end;
$$;

create or replace function public.add_trivia_question(
  _game_id uuid,_prompt text,_choices jsonb,_correct_index integer
)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_game public.trivia_games%rowtype; v_position integer; v_id uuid; v_choice text;
begin
  if v_user is null then raise exception 'Sign in to add questions.'; end if;
  select * into v_game from public.trivia_games where id=_game_id for update;
  if not found then raise exception 'Game not found.'; end if;
  if v_game.created_by<>v_user then raise exception 'Only the game creator can add questions.'; end if;
  if v_game.status<>'waiting' then raise exception 'Questions are locked after the game starts.'; end if;
  if char_length(btrim(coalesce(_prompt,'')))<1 or char_length(_prompt)>300 then raise exception 'Question must be 1–300 characters.'; end if;
  if jsonb_typeof(_choices)<>'array' or jsonb_array_length(_choices) not between 2 and 4 then raise exception 'Add 2–4 answer choices.'; end if;
  if _correct_index<0 or _correct_index>=jsonb_array_length(_choices) then raise exception 'Choose the correct answer.'; end if;
  for v_choice in select value from jsonb_array_elements_text(_choices) loop
    if char_length(btrim(v_choice))<1 or char_length(v_choice)>120 then raise exception 'Each answer must be 1–120 characters.'; end if;
  end loop;
  select coalesce(max(position),0)+1 into v_position from public.trivia_questions where game_id=_game_id;
  if v_position>30 then raise exception 'A Trivia game can have at most 30 questions.'; end if;
  insert into public.trivia_questions(game_id,position,prompt,choices,correct_index)
  values(_game_id,v_position,btrim(_prompt),_choices,_correct_index) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.remove_trivia_question(_question_id uuid)
returns void
language plpgsql security definer set search_path=''
as $$
declare v_game public.trivia_games%rowtype;
begin
  select g.* into v_game from public.trivia_games g join public.trivia_questions q on q.game_id=g.id where q.id=_question_id for update of g;
  if not found then raise exception 'Question not found.'; end if;
  if v_game.created_by<>auth.uid() then raise exception 'Only the game creator can remove questions.'; end if;
  if v_game.status<>'waiting' then raise exception 'Questions are locked after the game starts.'; end if;
  delete from public.trivia_questions where id=_question_id;
  with ordered as (
    select id,row_number() over(order by position,id)::integer as new_position
    from public.trivia_questions where game_id=v_game.id
  )
  update public.trivia_questions q set position=o.new_position from ordered o where q.id=o.id;
end;
$$;

create or replace function public.start_trivia_game(_game_id uuid)
returns void
language plpgsql security definer set search_path=''
as $$
declare v_game public.trivia_games%rowtype; v_count integer; v_players integer;
begin
  select * into v_game from public.trivia_games where id=_game_id for update;
  if not found then raise exception 'Game not found.'; end if;
  if v_game.created_by<>auth.uid() then raise exception 'Only the creator can start this game.'; end if;
  if v_game.status<>'waiting' then raise exception 'This game has already started.'; end if;
  select count(*) into v_count from public.trivia_questions where game_id=_game_id;
  select count(*) into v_players from public.trivia_players where game_id=_game_id;
  if v_count<1 then raise exception 'Add at least one question before starting.'; end if;
  if v_players<2 then raise exception 'At least two players must join before starting.'; end if;
  update public.trivia_games set status='active',current_question=1,question_started_at=now(),updated_at=now() where id=_game_id;
end;
$$;

create or replace function public.submit_trivia_answer(_game_id uuid,_choice_index integer)
returns boolean
language plpgsql security definer set search_path=''
as $$
declare v_game public.trivia_games%rowtype; v_question public.trivia_questions%rowtype; v_correct boolean;
begin
  if auth.uid() is null then raise exception 'Sign in to answer.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  select * into v_game from public.trivia_games where id=_game_id for update;
  if not found or v_game.status<>'active' then raise exception 'This question is not accepting answers.'; end if;
  if not exists(select 1 from public.trivia_players where game_id=_game_id and user_id=auth.uid()) then raise exception 'Join this game before answering.'; end if;
  if now()>v_game.question_started_at+make_interval(secs=>v_game.question_seconds) then raise exception 'Time is up for this question.'; end if;
  select * into v_question from public.trivia_questions where game_id=_game_id and position=v_game.current_question;
  if not found then raise exception 'Question not found.'; end if;
  if _choice_index<0 or _choice_index>=jsonb_array_length(v_question.choices) then raise exception 'Choose a valid answer.'; end if;
  v_correct:=_choice_index=v_question.correct_index;
  insert into public.trivia_answers(game_id,question_id,user_id,choice_index,is_correct)
  values(_game_id,v_question.id,auth.uid(),_choice_index,v_correct);
  if v_correct then update public.trivia_players set score=score+100 where game_id=_game_id and user_id=auth.uid(); end if;
  return v_correct;
exception when unique_violation then
  raise exception 'You already answered this question.';
end;
$$;

create or replace function public.advance_trivia_question(_game_id uuid)
returns void
language plpgsql security definer set search_path=''
as $$
declare v_game public.trivia_games%rowtype; v_total integer; v_answered integer; v_players integer;
begin
  select * into v_game from public.trivia_games where id=_game_id for update;
  if not found or v_game.status<>'active' then raise exception 'This game is not active.'; end if;
  if v_game.created_by<>auth.uid() then raise exception 'Only the creator can advance the game.'; end if;
  select count(*) into v_total from public.trivia_questions where game_id=_game_id;
  select count(*) into v_players from public.trivia_players where game_id=_game_id;
  select count(*) into v_answered from public.trivia_answers a join public.trivia_questions q on q.id=a.question_id
    where a.game_id=_game_id and q.position=v_game.current_question;
  if now()<v_game.question_started_at+make_interval(secs=>v_game.question_seconds) and v_answered<v_players then
    raise exception 'Wait for the timer or for everyone to answer.';
  end if;
  if v_game.current_question>=v_total then
    update public.trivia_games set status='completed',updated_at=now() where id=_game_id;
  else
    update public.trivia_games set current_question=current_question+1,question_started_at=now(),updated_at=now() where id=_game_id;
  end if;
end;
$$;

create or replace function public.get_trivia_game(_game_id uuid)
returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_game public.trivia_games%rowtype; v_question public.trivia_questions%rowtype; v_user uuid:=auth.uid(); v_question_count integer; v_player_list jsonb; v_has_answered boolean:=false;
begin
  select * into v_game from public.trivia_games where id=_game_id;
  if not found then raise exception 'Game not found.'; end if;
  if v_game.scope='post' then
    if not exists(select 1 from public.posts where id=v_game.post_id and status='published') then raise exception 'This post is no longer available.'; end if;
  elsif v_user is null or not public.is_dm_member(v_game.conversation_id) then raise exception 'Conversation access required.'; end if;
  select count(*) into v_question_count from public.trivia_questions where game_id=_game_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',p.user_id,
    'name',coalesce(nullif(u.raw_user_meta_data->>'display_name',''),'Player'),
    'score',p.score,
    'is_creator',p.user_id=v_game.created_by
  ) order by p.score desc,p.joined_at),'[]'::jsonb) into v_player_list
  from public.trivia_players p join auth.users u on u.id=p.user_id where p.game_id=_game_id;
  if v_game.status='active' and v_user is not null then
    select exists(select 1 from public.trivia_answers a join public.trivia_questions q on q.id=a.question_id
      where a.game_id=_game_id and q.position=v_game.current_question and a.user_id=v_user) into v_has_answered;
  end if;
  if v_game.status='active' then
    select * into v_question from public.trivia_questions where game_id=_game_id and position=v_game.current_question;
  end if;
  return jsonb_build_object(
    'id',v_game.id,'scope',v_game.scope,'post_id',v_game.post_id,'conversation_id',v_game.conversation_id,
    'created_by',v_game.created_by,'title',v_game.title,'status',v_game.status,
    'current_question',v_game.current_question,'question_count',v_question_count,
    'question_seconds',v_game.question_seconds,'question_started_at',v_game.question_started_at,
    'question',case when v_game.status='active' and v_question.id is not null then
      jsonb_build_object('id',v_question.id,'position',v_question.position,'prompt',v_question.prompt,'choices',v_question.choices)
      else null end,
    'has_answered',v_has_answered,'players',v_player_list,
    'questions',case when v_user=v_game.created_by and v_game.status='waiting' then
      coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'position',q.position,'prompt',q.prompt,'choices',q.choices) order by q.position)
        from public.trivia_questions q where q.game_id=_game_id),'[]'::jsonb)
      else '[]'::jsonb end,
    'is_creator',v_user=v_game.created_by
  );
end;
$$;

create or replace function public.list_trivia_games_for_posts(_post_ids uuid[])
returns jsonb
language plpgsql security definer set search_path=''
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',g.id,'post_id',g.post_id,'title',g.title,'created_by',g.created_by,'status',g.status,
      'player_count',(select count(*) from public.trivia_players p where p.game_id=g.id),
      'question_count',(select count(*) from public.trivia_questions q where q.game_id=g.id),
      'created_at',g.created_at
    ) order by g.created_at desc)
    from public.trivia_games g join public.posts p on p.id=g.post_id
    where g.scope='post' and g.post_id=any(_post_ids) and p.status='published'
  ),'[]'::jsonb);
end;
$$;

create or replace function public.list_trivia_games_for_conversation(_conversation_id uuid)
returns jsonb
language plpgsql security definer set search_path=''
as $$
begin
  if auth.uid() is null or not public.is_dm_member(_conversation_id) then raise exception 'Conversation access required.'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',g.id,'title',g.title,'created_by',g.created_by,'status',g.status,
      'player_count',(select count(*) from public.trivia_players p where p.game_id=g.id),
      'question_count',(select count(*) from public.trivia_questions q where q.game_id=g.id),
      'created_at',g.created_at
    ) order by g.created_at desc)
    from public.trivia_games g where g.scope='message' and g.conversation_id=_conversation_id
  ),'[]'::jsonb);
end;
$$;

revoke all on function public.create_trivia_game(text,uuid,uuid,text) from public;
revoke all on function public.join_trivia_game(uuid) from public;
revoke all on function public.add_trivia_question(uuid,text,jsonb,integer) from public;
revoke all on function public.remove_trivia_question(uuid) from public;
revoke all on function public.start_trivia_game(uuid) from public;
revoke all on function public.submit_trivia_answer(uuid,integer) from public;
revoke all on function public.advance_trivia_question(uuid) from public;
revoke all on function public.get_trivia_game(uuid) from public;
revoke all on function public.list_trivia_games_for_posts(uuid[]) from public;
revoke all on function public.list_trivia_games_for_conversation(uuid) from public;

grant execute on function public.create_trivia_game(text,uuid,uuid,text) to authenticated;
grant execute on function public.join_trivia_game(uuid) to authenticated;
grant execute on function public.add_trivia_question(uuid,text,jsonb,integer) to authenticated;
grant execute on function public.remove_trivia_question(uuid) to authenticated;
grant execute on function public.start_trivia_game(uuid) to authenticated;
grant execute on function public.submit_trivia_answer(uuid,integer) to authenticated;
grant execute on function public.advance_trivia_question(uuid) to authenticated;
grant execute on function public.get_trivia_game(uuid) to anon,authenticated;
grant execute on function public.list_trivia_games_for_posts(uuid[]) to anon,authenticated;
grant execute on function public.list_trivia_games_for_conversation(uuid) to authenticated;


-- Battleship is intentionally limited to one-to-one direct conversations.
create or replace function public.create_battleship_game(_conversation_id uuid)
returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=auth.uid(); v_id uuid;
begin
  if v_user is null then raise exception 'Sign in to create a game.'; end if;
  if public.is_current_user_banned() then raise exception 'This account is suspended.'; end if;
  if not public.is_dm_member(_conversation_id) then raise exception 'Only conversation members can create a game.'; end if;
  if exists(select 1 from public.dm_conversations where id=_conversation_id and conversation_type='group') then
    raise exception 'Battleship is only available in direct messages.';
  end if;
  insert into public.battleship_games(conversation_id,created_by,player_one)
  values(_conversation_id,v_user,v_user) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.create_battleship_game(uuid) from public;
grant execute on function public.create_battleship_game(uuid) to authenticated;
