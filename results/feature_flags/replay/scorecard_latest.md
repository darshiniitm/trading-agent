# Scorecard (replay), as of 2026-09-29

n_weeks in flags_met rank-IC: 107, maturity=REAL_READ

```
                 flag_id  n_weeks  mean_prevalence  lift_mean  lift_ci_lo  lift_ci_hi  hit_rate_flag1  hit_rate_flag0  p_value  maturity  bh_q_value  significant_after_bh
       A01_vstop_flip_up       71           0.0254    -0.2315     -0.6541      0.2214          0.3724          0.4159   0.3132 REAL_READ      0.8409                 False
       A02_vstop_uptrend      107           0.4723     0.0240     -0.1584      0.2054          0.4069          0.4218   0.7800 REAL_READ      0.8905                 False
         A03_rsi_in_band      107           0.3714     0.0292     -0.1252      0.1844          0.4083          0.4186   0.6908 REAL_READ      0.8905                 False
         A04_risk_cap_ok      107           0.3781     0.0562     -0.1295      0.2393          0.4081          0.4189   0.5292 REAL_READ      0.8599                 False
    B01_sector_rs_4w_pos      107           0.4804     0.0480     -0.1354      0.2330          0.4182          0.4116   0.6036 REAL_READ      0.8719                 False
        B02_sector_top_k      107           0.2355     0.0823     -0.1309      0.2897          0.4162          0.4144   0.4444 REAL_READ      0.8409                 False
   B03_sector_rs_13w_pos      107           0.5383     0.0073     -0.1696      0.1829          0.4236          0.4046   0.9584 REAL_READ      0.9584                 False
    B04_volume_expansion      107           0.1495    -0.2399     -0.4432     -0.0124          0.3929          0.4186   0.0384 REAL_READ      0.2496                 False
B05_trend_quality_strong      100           0.0781    -0.5319     -0.8715     -0.1988          0.3932          0.4166   0.0020 REAL_READ      0.0260                  True
  B06_rsi_sweetspot_core      107           0.1847     0.0665     -0.1052      0.2395          0.4087          0.4162   0.4528 REAL_READ      0.8409                 False
   C01_risk_headroom_5pp      107           0.2007     0.0189     -0.1699      0.2011          0.4093          0.4162   0.8220 REAL_READ      0.8905                 False
        C02_liquidity_2x        7           0.9963     0.7574     -1.0276      2.5871          0.4145          0.4857   0.4224 TOO_EARLY      0.8409                 False
    C03_cap_band_central      107           0.4081    -0.0494     -0.1662      0.0699          0.4119          0.4168   0.4276 REAL_READ      0.8409                 False
```

## flags_met buckets

```
bucket     n  mean_excess_pct  hit_rate
   0-3 10599           -0.034    0.4187
   4-6 11267            0.051    0.4116
   7-9  5963           -0.031    0.4144
 10-13   390           -0.063    0.4103
```
