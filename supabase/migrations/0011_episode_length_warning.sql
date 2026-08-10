-- The bounded semantic pipeline now keeps a transcript that lands just short of
-- the selected episode length as a warned draft instead of discarding the run.
alter table if exists episodes
  drop constraint if exists episodes_generation_warning_check;

alter table if exists episodes
  add constraint episodes_generation_warning_check
  check (
    generation_warning is null
    or generation_warning in ('title_validation_failed', 'length_below_target')
  );
