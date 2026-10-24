create view fwd.v_flag_matrix_wide as
select run_id, instrument_id,
       jsonb_object_agg(condition_key, value order by condition_key) as flags,
       sum(value)::int as flags_met
from fwd.condition_flags
group by run_id, instrument_id;

create view fwd.v_weekly_report as
select r.run_id, a.arm_name, r.signal_week_id, r.signal_date,
       i.symbol, c.candidate_class, c.reject_reason, c.conditions_met, c.snapshot,
       t.trade_id, t.entry_price, t.stop_loss, t.exit_plan_price, t.confidence, t.r_pct,
       t.is_shadow, s.sector, s.industry
from fwd.runs r
join fwd.arms a on a.arm_id = r.arm_id
join fwd.candidates c on c.run_id = r.run_id
join ref.instruments i on i.instrument_id = c.instrument_id
left join fwd.trades t on t.run_id = r.run_id and t.instrument_id = c.instrument_id
left join ref.instrument_sector isc on isc.instrument_id = c.instrument_id
     and isc.valid_from <= r.signal_date and (isc.valid_to is null or isc.valid_to >= r.signal_date)
left join ref.sectors s on s.sector_id = isc.sector_id;

create view fwd.v_arm_performance as
select a.arm_name, r.signal_week_id, r.signal_date, o.horizon_weeks,
       count(*) as n_trades,
       avg(o.return_pct_net) as avg_return_pct_net,
       avg((o.return_pct_net > 0)::int) as hit_rate
from fwd.trade_outcomes o
join fwd.trades t on t.trade_id = o.trade_id
join fwd.runs r on r.run_id = t.run_id
join fwd.arms a on a.arm_id = r.arm_id
where not t.is_shadow
group by a.arm_name, r.signal_week_id, r.signal_date, o.horizon_weeks;

create view app.v_watchlist_live as
select w.watchlist_id, w.prompt_id, i.symbol, wi.candidate_class,
       wi.conditions_met, wi.conditions_total, q.price, q.as_of as price_as_of
from app.watchlist_items wi
join app.watchlists w on w.watchlist_id = wi.watchlist_id
join ref.instruments i on i.instrument_id = wi.instrument_id
left join market.quote_cache q on q.instrument_id = wi.instrument_id;

create view prompt_details.v_prompt_trace as
select pr.prompt_id, pr.prompt_run_id, pr.prompt_text, pr.status, pr.final_answer,
       ao.step_no, ao.agent_name, ao.input, ao.output, ao.model, ao.duration_ms, ao.error
from prompt_details.prompt_runs pr
left join prompt_details.agent_outputs ao on ao.prompt_run_id = pr.prompt_run_id
order by pr.prompt_run_id, ao.step_no;
