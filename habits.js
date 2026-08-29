/* =============================================================
   habits.js — the single definition of Finn's recurring tasks.
   Loaded by index.html (Now card) and main.html (Daily list) so
   the two can never drift apart.

   from : hour the task becomes due (0 = start of day)
   dow  : days of week it applies to (0=Sun .. 6=Sat). Absent = every day.
   chore: weekly job — sorted to the top, gone until it comes round again.
   ============================================================= */
(function () {
  'use strict';

  window.HABIT_ITEMS = [
    /* --- weekly jobs --- */
    { id:'mealprep', text:'Meal prep',      sub:'Venison, rice, veg. Five containers.', from:0, dow:[0], chore:true },
    { id:'sheets',   text:'Change sheets',  from:0, dow:[6], chore:true },
    { id:'washing',  text:'Sort washing',   from:0, dow:[6], chore:true },
    { id:'vacuum',   text:'Vacuum room',    from:0, dow:[6], chore:true },

    /* --- morning --- */
    { id:'bed',      text:'Make bed',       from:0 },
    { id:'teethAm',  text:'Brush teeth',    from:0 },
    { id:'gym',      text:'Gym',            from:0, dow:[1,2,4,5] },
    { id:'walk',     text:'Walk to office', from:0, dow:[1,2,3,4,5] },

    /* --- evening --- */
    { id:'food',     text:'Ate whole foods only', from:17 },
    { id:'teethPm',  text:'Brush teeth',          from:17 },
    { id:'clean',    text:'Log a clean day', sub:'No drink, no nicotine', from:17, streak:true }
  ];

  /* Every task that applies on this date, regardless of time. */
  window.habitsForDay = function (date) {
    var dow = date.getDay();
    return window.HABIT_ITEMS.filter(function (i) {
      return !i.dow || i.dow.indexOf(dow) !== -1;
    });
  };

  /* Tasks that have opened by `hour` on this date. A task stays due
     once its window opens — it only leaves the list when ticked. */
  window.habitsDue = function (date, hour) {
    return window.habitsForDay(date).filter(function (i) { return hour >= i.from; });
  };
})();
