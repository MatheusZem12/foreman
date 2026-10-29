-- A parallel stage: it sits next to the previous stage in the workflow and shares the same
-- board column (one under the other). E.g. after "Priority", "Hard" and "Medium" in
-- parallel, each receiving one kind of issue.
alter table stages add column parallel boolean not null default false;
