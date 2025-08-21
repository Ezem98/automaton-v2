var dfa_delegate = (function () {
  var self = null;
  var dfa = null;
  var container = null;
  var dialogDiv = null;
  var dialogActiveConnection = null;
  var statusConnector = null;

  // ---------- Utils: parsing & compaction ----------
  function isDigit(ch) { return ch >= '0' && ch <= '9'; }
  function isUpper(ch) { return ch >= 'A' && ch <= 'Z'; }
  function isLower(ch) { return ch >= 'a' && ch <= 'z'; }

  function sameClass(a, b) {
    return (isDigit(a) && isDigit(b)) ||
           (isUpper(a) && isUpper(b)) ||
           (isLower(a) && isLower(b));
  }

  // Expande especificaciones como:
  // "A-Z, a-z, 0-9", "abc", "0-3,7", "[a-c]", "x, y, z"
  function expandSpecToChars(spec) {
    if (!spec) return [];
    var s = ('' + spec).trim();
    if (!s) return [];

    // Quitar corchetes opcionales tipo [a-z]
    if (/^\[.*\]$/.test(s)) s = s.slice(1, -1);

    // Separar por comas o espacios
    var tokens = s.split(/[\s,]+/).filter(Boolean);
    var out = [];

    tokens.forEach(function (tok) {
      // Rango simple X-Y (letras o dígitos)
      var m = /^([A-Za-z0-9])-([A-Za-z0-9])$/.exec(tok);
      if (m) {
        var a = m[1].charCodeAt(0), b = m[2].charCodeAt(0);
        if (a > b) { var t = a; a = b; b = t; }
        for (var c = a; c <= b; c++) out.push(String.fromCharCode(c));
        return;
      }
      // Cadena larga "abc" => a, b, c
      if (/^[A-Za-z0-9_]+$/.test(tok) && tok.length > 1) {
        for (var i = 0; i < tok.length; i++) out.push(tok[i]);
        return;
      }
      // Un solo carácter visible (permitimos guion bajo también)
      if (tok.length === 1) {
        out.push(tok);
        return;
      }
      // Si llega algo raro, lo ignoramos silenciosamente.
    });

    // De-dup
    var seen = Object.create(null);
    var arr = [];
    out.forEach(function (ch) {
      if (!seen[ch]) { seen[ch] = true; arr.push(ch); }
    });
    return arr;
  }

  function tokenForRange(a, b) {
    return (a === b) ? a : (a + '-' + b);
  }

  // Compacta una lista de chars a "A-Z, a, b, 0-9" agrupando por clase y contiguidad
  function compactChars(chars) {
    if (!chars || !chars.length) return '';
    var list = chars.slice().sort(function (x, y) {
      return x.charCodeAt(0) - y.charCodeAt(0);
    });

    var res = [];
    var start = list[0];
    var prev = list[0];

    for (var i = 1; i < list.length; i++) {
      var ch = list[i];
      if (sameClass(prev, ch) && ch.charCodeAt(0) === prev.charCodeAt(0) + 1) {
        prev = ch; // seguimos rango
      } else {
        res.push(tokenForRange(start, prev));
        start = prev = ch;
      }
    }
    res.push(tokenForRange(start, prev));

    return res.join(', ');
  }

  // Retorna todos los símbolos que en el modelo van de source->target (según DFA actual)
  function getCharsForConnection(sourceId, targetId) {
    var model = dfa.serialize();           // { transitions: { stateA: { ch: stateB } } , ... }
    var bySource = model.transitions[sourceId] || {};
    var acc = [];
    $.each(bySource, function (ch, dest) {
      if (dest === targetId) acc.push(ch);
    });
    return acc;
  }

  // ---------- UI de depuración ----------
  var updateUIForDebug = function () {
    var status = dfa.status();
    $('.current').removeClass('current');

    if (statusConnector) { jsPlumb.Defaults.PaintStyle && statusConnector.setPaintStyle(jsPlumb.Defaults.PaintStyle); }

    var curState = $('#' + status.state).addClass('current');
    jsPlumb.select({ source: status.state }).each(function (connection) {
      if (connection.getLabel() === status.nextChar) {
        statusConnector = connection;
        connection.setPaintStyle({ strokeStyle: '#0a0' });
      }
    });
    return self;
  };

  // ---------- Diálogo ----------
  var dialogSave = function (update) {
    var inputSpec = $('#dfa_dialog_readCharTxt').val();
    inputSpec = inputSpec != null ? ('' + inputSpec).trim() : '';

    if (!inputSpec) {
      alert("Deterministic Finite Automaton cannot have empty-string transition.");
      return;
    }

    var sourceId = dialogActiveConnection.sourceId;
    var targetId = dialogActiveConnection.targetId;

    // Expandir a caracteres individuales
    var chars = expandSpecToChars(inputSpec);
    if (!chars.length) {
      alert("No hay símbolos válidos en la especificación.");
      return;
    }

    // Si estamos editando, eliminar TODAS las transiciones actuales source->target
    if (update) {
      var existing = getCharsForConnection(sourceId, targetId);
      existing.forEach(function (ch) {
        dfa.removeTransition(sourceId, ch, targetId);
      });
    }

    // Verificar conflictos de determinismo (algún símbolo ya usado hacia OTRO estado)
    var model = dfa.serialize();
    var bySource = model.transitions[sourceId] || {};
    var conflicts = [];

    chars.forEach(function (ch) {
      var already = bySource[ch];
      if (already && already !== targetId) conflicts.push(ch);
    });

    if (conflicts.length) {
      alert(sourceId + " ya tiene transición(es) para: " + conflicts.join(', '));
      return;
    }

    // Agregar todas las transiciones al modelo
    chars.forEach(function (ch) {
      dfa.addTransition(sourceId, ch, targetId);
    });

    // Compactar y rotular la conexión
    dialogActiveConnection.setLabel(compactChars(getCharsForConnection(sourceId, targetId)));

    dialogDiv.dialog("close");
  };

  var dialogCancel = function (update) {
    if (!update) { fsm.removeConnection(dialogActiveConnection); }
    dialogDiv.dialog("close");
  };

  var dialogDelete = function () {
    // Eliminar TODAS las transiciones modelo source->target
    var sourceId = dialogActiveConnection.sourceId;
    var targetId = dialogActiveConnection.targetId;
    var existing = getCharsForConnection(sourceId, targetId);
    existing.forEach(function (ch) {
      dfa.removeTransition(sourceId, ch, targetId);
    });
    fsm.removeConnection(dialogActiveConnection);
    dialogDiv.dialog("close");
  };

  var dialogClose = function () {
    dialogActiveConnection = null;
  };

  var makeDialog = function () {
    dialogDiv = $('<div>', { style: 'text-align:center;' });

    $('<div>', { style: 'font-size:small;' })
      .html('DFAs no aceptan ε. Usá caracteres sueltos, rangos <code>A-Z</code>, <code>a-z</code>, <code>0-9</code> o listas separadas por coma. Ej: <code>A-Z, a, 0-3</code>')
      .appendTo(dialogDiv);

    $('<span>', { id: 'dfa_dialog_stateA', 'class': 'tranStart' }).appendTo(dialogDiv);

    $('<input>', {
      id: 'dfa_dialog_readCharTxt',
      type: 'text',
      // sin maxlength, permitimos specs largas
      style: 'width: 260px; text-align:center;'
    })
      .attr('placeholder', 'Ej: A-Z, a-z, 0-9, _')
      .keypress(function (event) {
        if (event.which === $.ui.keyCode.ENTER) {
          dialogDiv.parent().find('div.ui-dialog-buttonset button').eq(-1).click();
        }
      })
      .appendTo(dialogDiv);

    $('<span>', { id: 'dfa_dialog_stateB', 'class': 'tranEnd' }).appendTo(dialogDiv);

    $('body').append(dialogDiv);
    dialogDiv.dialog({
      dialogClass: "no-close",
      autoOpen: false,
      title: 'Set Transition Characters',
      height: 240,
      width: 520,
      modal: true,
      open: function () { dialogDiv.find('input').focus().select(); },
      close: dialogClose
    });
  };

  // ---------- API pública esperada por fsm_ui ----------
  return {
    init: function () {
      self = this;
      dfa = new DFA();
      makeDialog();
      return self;
    },

    setContainer: function (newContainer) {
      container = newContainer;
      return self;
    },

    fsm: function () { return dfa; },

    connectionAdded: function (info) {
      dialogActiveConnection = info.connection;

      // Mostrar estados
      $('#dfa_dialog_stateA').html(dialogActiveConnection.sourceId + ' ');
      $('#dfa_dialog_stateB').html(' ' + dialogActiveConnection.targetId);

      // Pre-fill vacío (o un ejemplo si preferís, p.ej. "a-z")
      $('#dfa_dialog_readCharTxt').val('');

      dialogDiv.dialog('option', 'buttons', {
        Cancel: function () { dialogCancel(false); },
        Save: function () { dialogSave(false); }
      }).dialog("open");
    },

    connectionClicked: function (connection) {
      dialogActiveConnection = connection;

      // Prefill con lo que ya tiene el modelo para source->target (compactado)
      var pre = compactChars(getCharsForConnection(connection.sourceId, connection.targetId));
      $('#dfa_dialog_readCharTxt').val(pre);

      dialogDiv.dialog('option', 'buttons', {
        Cancel: function () { dialogCancel(true); },
        Delete: dialogDelete,
        Save: function () { dialogSave(true); }
      }).dialog("open");
    },

    updateUI: updateUIForDebug,

    getEmptyLabel: function () { return null; },

    reset: function () {
      dfa = new DFA();
      return self;
    },

    debugStart: function () { return self; },
    debugStop: function () { $('.current').removeClass('current'); return self; },

    // Serialización en formato común que fsm_ui espera (SIN cambios)
    serialize: function () {
      var model = {};
      model.type = 'DFA';
      model.dfa = dfa.serialize();
      model.states = {};
      model.transitions = [];

      $.each(model.dfa.transitions, function (stateA, transition) {
        model.states[stateA] = {};
        $.each(transition, function (character, stateB) {
          model.states[stateB] = {};
          model.transitions.push({ stateA: stateA, label: character, stateB: stateB });
        });
      });

      $.each(model.dfa.acceptStates, function (index, state) {
        model.states[state].isAccept = true;
      });

      return model;
    },

    deserialize: function (model) {
      dfa.deserialize(model.dfa);
    }
  };
}()).init();
