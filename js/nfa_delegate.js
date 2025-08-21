var nfa_delegate = (function() {
  var self = null;
  var nfa = null;
  var container = null;
  var dialogDiv = null;
  var dialogActiveConnection = null;
  var emptyLabel = 'ϵ';
  
  var statusConnectors = [];

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

  // Retorna todos los símbolos que en el modelo van de source->target (según NFA actual)
  function getCharsForConnection(sourceId, targetId) {
    var model = nfa.serialize();
    var bySource = model.transitions[sourceId] || {};
    var acc = [];
    $.each(bySource, function (ch, destinations) {
      if (destinations.indexOf && destinations.indexOf(targetId) !== -1) {
        acc.push(ch);
      }
    });
    return acc;
  }
  
  var updateUIForDebug = function() {
    var status = nfa.status();
    
    $('.current').removeClass('current');
    $.each(statusConnectors, function(index, connection) {
      connection.setPaintStyle(jsPlumb.Defaults.PaintStyle);
    });
    
    var comparisonChar = status.nextChar === '' ? emptyLabel : status.nextChar;
    $.each(status.states, function(index, state) {
      var curState = $('#' + state).addClass('current');
      jsPlumb.select({source:state}).each(function(connection) {
        if (connection.getLabel() === comparisonChar) {
          statusConnectors.push(connection);
          connection.setPaintStyle({strokeStyle:'#0a0'});
        }
      });
    });
    return self;
  };

  var dialogSave = function(update) {
    var inputSpec = $('#nfa_dialog_readCharTxt').val();
    inputSpec = inputSpec != null ? ('' + inputSpec).trim() : '';

    var sourceId = dialogActiveConnection.sourceId;
    var targetId = dialogActiveConnection.targetId;

    // Si está vacío, es epsilon
    if (!inputSpec) {
      if (update) {
        nfa.removeTransition(sourceId, dialogActiveConnection.getLabel(), targetId);
      } else if (nfa.hasTransition(sourceId, '', targetId)) {
        alert(sourceId + " already has a transition to " + targetId + " on " + emptyLabel);
        return;
      }
      
      dialogActiveConnection.setLabel(emptyLabel);
      nfa.addTransition(sourceId, '', targetId);
      dialogDiv.dialog("close");
      return;
    }

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
        nfa.removeTransition(sourceId, ch, targetId);
      });
    }

    // Verificar conflictos antes de agregar
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (!update && nfa.hasTransition(sourceId, ch, targetId)) {
        alert(sourceId + " already has a transition to " + targetId + " on " + ch);
        return;
      }
    }

    // Agregar todas las transiciones
    chars.forEach(function (ch) {
      nfa.addTransition(sourceId, ch, targetId);
    });

    // Actualizar etiqueta visual con formato compacto
    var compactLabel = compactChars(chars);
    dialogActiveConnection.setLabel(compactLabel);
    
    dialogDiv.dialog("close");
  };

  var dialogCancel = function(update) {
    if (!update) {fsm.removeConnection(dialogActiveConnection);}
    dialogDiv.dialog("close");
  };
  
  var dialogDelete = function() {
    nfa.removeTransition(dialogActiveConnection.sourceId, dialogActiveConnection.getLabel(), dialogActiveConnection.targetId);
    fsm.removeConnection(dialogActiveConnection);
    dialogDiv.dialog("close");
  };
  
  var dialogClose = function() {
    dialogActiveConnection = null;
  };

  var makeDialog = function() {
    dialogDiv = $('<div></div>', {style:'text-align:center;'});
    $('<div>', { style: 'font-size:small;' })
      .html('NFAs aceptan ε (vacío). Usá caracteres sueltos, rangos <code>A-Z</code>, <code>a-z</code>, <code>0-9</code> o listas separadas por coma. Ej: <code>A-Z, a, 0-3</code>')
      .appendTo(dialogDiv);

    $('<span>', { id: 'nfa_dialog_stateA', 'class': 'tranStart' }).appendTo(dialogDiv);

    $('<input>', {
      id: 'nfa_dialog_readCharTxt',
      type: 'text',
      style: 'width: 260px; text-align:center;'
    })
      .attr('placeholder', 'Ej: A-Z, a-z, 0-9, _ (vacío = ε)')
      .keypress(function (event) {
        if (event.which === $.ui.keyCode.ENTER) {
          dialogDiv.parent().find('div.ui-dialog-buttonset button').eq(-1).click();
        }
      })
      .appendTo(dialogDiv);

    $('<span>', { id: 'nfa_dialog_stateB', 'class': 'tranEnd' }).appendTo(dialogDiv);

    $('body').append(dialogDiv);
    
    dialogDiv.dialog({
      dialogClass: "no-close",
      autoOpen: false,
      title: 'Set Transition Characters',
      height: 240,
      width: 520,
      modal: true,
      open: function() {dialogDiv.find('input').focus().select();}
    });
  };

  return {
    init: function() {
      self = this;
      nfa = new NFA();
      makeDialog();
      return self;
    },
    
    setContainer: function(newContainer) {
      container = newContainer;
      return self;
    },
    
    fsm: function() {
      return nfa;
    },
    
    connectionAdded: function(info) {
      dialogActiveConnection = info.connection;
      $('#nfa_dialog_stateA').html(dialogActiveConnection.sourceId + '&nbsp;');
      $('#nfa_dialog_stateB').html('&nbsp;' + dialogActiveConnection.targetId);
      
      dialogDiv.dialog('option', 'buttons', {
        Cancel: function(){dialogCancel(false);},
        Save: function(){dialogSave(false);}
      }).dialog("open");
    },
    
    connectionClicked: function(connection) {
      dialogActiveConnection = connection;
      $('#nfa_dialog_readCharTxt').val(dialogActiveConnection.getLabel());
      dialogDiv.dialog('option', 'buttons', {
        Cancel: function(){dialogCancel(true);},
        Delete: dialogDelete,
        Save: function(){dialogSave(true);}
      }).dialog("open");
    },
    
    updateUI: updateUIForDebug,
    
    getEmptyLabel: function() {return emptyLabel;},
    
    reset: function() {
      nfa = new NFA();
      return self;
    },
    
    debugStart: function() {
      return self;
    },
    
    debugStop: function() {
      $('.current').removeClass('current');
      return self;
    },
    
    serialize: function() {
      // Convert dfa into common serialized format
      var model = {};
      model.type = 'NFA';
      model.nfa = nfa.serialize();
      model.states = {};
      model.transitions = [];
      $.each(model.nfa.transitions, function(stateA, transition) {
        model.states[stateA] = {};
        $.each(transition, function(character, states) {
          $.each(states, function(index, stateB) {
            model.states[stateB] = {};
            model.transitions.push({stateA:stateA, label:(character || emptyLabel), stateB:stateB});
          });
        });
      });
      $.each(model.nfa.acceptStates, function(index, state) {
        model.states[state].isAccept = true;
      });
      return model;
    },
    
    deserialize: function(model) {
      nfa.deserialize(model.nfa);
    }
  };
}()).init();
