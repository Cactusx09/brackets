/*
 * Copyright 2011 Adobe Systems Incorporated. All Rights Reserved.
 */

/*jslint vars: true, plusplus: true, devel: true, browser: true, nomen: true, indent: 4, maxerr: 50 */
/*global define: false, brackets: true, $: false, PathUtils: false */

/**
 * brackets is the root of the Brackets codebase. This file pulls in all other modules as
 * dependencies (or dependencies thereof), initializes the UI, and binds global menus & keyboard
 * shortcuts to their Commands.
 *
 * TODO: (issue #264) break out the definition of brackets into a separate module from the application controller logic
 *
 * Unlike other modules, this one can be accessed without an explicit require() because it exposes
 * a global object, window.brackets.
 */
define(function (require, exports, module) {
    'use strict';
    
    // Load dependent non-module scripts
    require("widgets/bootstrap-dropdown");
    require("widgets/bootstrap-modal");
    require("thirdparty/path-utils/path-utils.min");
    
    // Load dependent modules
    var ProjectManager          = require("ProjectManager"),
        DocumentManager         = require("DocumentManager"),
        EditorManager           = require("EditorManager"),
        WorkingSetView          = require("WorkingSetView"),
        FileCommandHandlers     = require("FileCommandHandlers"),
        FileViewController      = require("FileViewController"),
        FileSyncManager         = require("FileSyncManager"),
        KeyBindingManager       = require("KeyBindingManager"),
        KeyMap                  = require("KeyMap"),
        Commands                = require("Commands"),
        CommandManager          = require("CommandManager"),
        PerfUtils               = require("PerfUtils"),
        Menus                   = require("Menus");
    
    //Load modules the self-register and just need to get included in the main project
    require("JSLint");
    require("CodeHintManager");
    require("DebugCommandHandlers");

    // Define core brackets namespace if it isn't already defined
    //
    // We can't simply do 'brackets = {}' to define it in the global namespace because
    // we're in "use strict" mode. Most likely, 'window' will always point to the global
    // object when this code is running. However, in case it isn't (e.g. if we're running 
    // inside Node for CI testing) we use this trick to get the global object.
    //
    // Taken from:
    //   http://stackoverflow.com/questions/3277182/how-to-get-the-global-object-in-javascript
    var Fn = Function, global = (new Fn('return this'))();
    if (!global.brackets) {
        global.brackets = {};
    }
    
    // TODO: (issue #265) Make sure the "test" object is not included in final builds
    // All modules that need to be tested from the context of the application
    // must to be added to this object. The unit tests cannot just pull
    // in the modules since they would run in context of the unit test window,
    // and would not have access to the app html/css.
    brackets.test = {
        PreferencesManager      : require("PreferencesManager"),
        ProjectManager          : ProjectManager,
        FileCommandHandlers     : FileCommandHandlers,
        FileViewController      : FileViewController,
        DocumentManager         : DocumentManager,
        Commands                : Commands,
        WorkingSetView          : WorkingSetView,
        CommandManager          : require("CommandManager")
    };
    
    // Uncomment the following line to force all low level file i/o routines to complete
    // asynchronously. This should only be done for testing/debugging.
    // NOTE: Make sure this line is commented out again before committing!
    // brackets.forceAsyncCallbacks = true;

    // Load native shell when brackets is run in a native shell rather than the browser
    // TODO: (issue #266) load conditionally
    brackets.shellAPI = require("ShellAPI");
    
    brackets.inBrowser = !brackets.hasOwnProperty("fs");
    
    brackets.platform = (global.navigator.platform === "MacIntel" || global.navigator.platform === "MacPPC") ? "mac" : "win";

    brackets.DIALOG_BTN_CANCEL = "cancel";
    brackets.DIALOG_BTN_OK = "ok";
    brackets.DIALOG_BTN_DONTSAVE = "dontsave";
    brackets.DIALOG_CANCELED = "_canceled";

    brackets.DIALOG_ID_ERROR = "error-dialog";
    brackets.DIALOG_ID_SAVE_CLOSE = "save-close-dialog";
    brackets.DIALOG_ID_EXT_CHANGED = "ext-changed-dialog";
    brackets.DIALOG_ID_EXT_DELETED = "ext-deleted-dialog";

    /**
     * General purpose modal dialog. Assumes that:
     * -- the root tag of the dialog is marked with a unique class name (passed as dlgClass), as well as the
     *    classes "template modal hide".
     * -- the HTML for the dialog contains elements with "title" and "message" classes, as well as a number 
     *    of elements with "dialog-button" class, each of which has a "data-button-id".
     *
     * @param {string} dlgClass The class of the dialog node in the HTML.
     * @param {string} title The title of the error dialog. Can contain HTML markup.
     * @param {string} message The message to display in the error dialog. Can contain HTML markup.
     * @return {Deferred} a $.Deferred() that will be resolved with the ID of the clicked button when the dialog
     *     is dismissed. Never rejected.
     */
    brackets.showModalDialog = function (dlgClass, title, message, callback) {
        var result = $.Deferred();
        
        // We clone the HTML rather than using it directly so that if two dialogs of the same
        // type happen to show up, they can appear at the same time. (This is an edge case that
        // shouldn't happen often, but we can't prevent it from happening since everything is
        // asynchronous.)
        // TODO: (issue #258) In future, we should templatize the HTML for the dialogs rather than having 
        // it live directly in the HTML.
        var dlg = $("." + dlgClass + ".template")
            .clone()
            .removeClass("template")
            .addClass("instance")
            .appendTo(document.body);

        // Set title and message
        $(".dialog-title", dlg).html(title);
        $(".dialog-message", dlg).html(message);

        // Pipe dialog-closing notification back to client code
        dlg.one("hidden", function () {
            var buttonId = dlg.data("buttonId");
            if (!buttonId) {    // buttonId will be undefined if closed via Bootstrap's "x" button
                buttonId = brackets.DIALOG_BTN_CANCEL;
            }
            
            // Let call stack return before notifying that dialog has closed; this avoids issue #191
            // if the handler we're triggering might show another dialog (as long as there's no
            // fade-out animation)
            setTimeout(function () {
                result.resolve(buttonId);
            }, 0);
            
            // Remove the dialog instance from the DOM.
            dlg.remove();
        });

        function stopEvent(e) {
            // Stop the event if the target is not inside the dialog
            if (!($.contains(dlg.get(0), e.target))) {
                e.stopPropagation();
                e.preventDefault();
            }
        }
        
        // Enter/Return handler for the primary button. Need to
        // add both keydown and keyup handlers here to make sure
        // the enter key was pressed while the dialog was showing.
        // Otherwise, if a keydown or keypress from somewhere else
        // triggered an alert, the keyup could immediately dismiss it.
        var enterKeyPressed = false;
        
        function keydownHandler(e) {
            if (e.keyCode === 13) {
                enterKeyPressed = true;
            }
            stopEvent(e);
        }
        
        function keyupHandler(e) {
            if (e.keyCode === 13 && enterKeyPressed) {
                var primaryBtn = dlg.find(".primary");
                if (primaryBtn) {
                    brackets._dismissDialog(dlg, primaryBtn.attr("data-button-id"));
                }
            }
            enterKeyPressed = false;
            stopEvent(e);
        }
        
        // These handlers are added at the capture phase to make sure we
        // get first crack at the events. 
        document.body.addEventListener("keydown", keydownHandler, true);
        document.body.addEventListener("keyup", keyupHandler, true);
        
        // Click handler for buttons
        dlg.one("click", ".dialog-button", function (e) {
            brackets._dismissDialog(dlg, $(this).attr("data-button-id"));
        });

        // Run the dialog
        dlg.modal({
            backdrop: "static",
            show: true
        }).on("hide", function (e) {
            // Remove key event handlers
            document.body.removeEventListener("keydown", keydownHandler, true);
            document.body.removeEventListener("keyup", keyupHandler, true);
        });
        return result;
    };
    
    /**
     * Immediately closes any dialog instances with the given class. The dialog callback for each instance will 
     * be called with the special buttonId brackets.DIALOG_CANCELED (note: callback is run asynchronously).
     */
    brackets.cancelModalDialogIfOpen = function (dlgClass) {
        $("." + dlgClass + ".instance").each(function (dlg) {
            if (dlg.is(":visible")) {   // Bootstrap breaks if try to hide dialog that's already hidden
                brackets._dismissDialog(dlg, brackets.DIALOG_CANCELED);
            }
        });
    };
    
    brackets._dismissDialog = function (dlg, buttonId) {
        dlg.data("buttonId", buttonId);
        dlg.modal(true).hide();
    };


    // Main Brackets initialization
    $(document).ready(function () {
        
        function initListeners() {
            // Prevent unhandled drag and drop of files into the browser from replacing 
            // the entire Brackets app. This doesn't prevent children from choosing to
            // handle drops.
            $(document.body)
                .on("dragover", function (event) {
                    if (event.originalEvent.dataTransfer.files) {
                        event.stopPropagation();
                        event.preventDefault();
                        event.originalEvent.dataTransfer.dropEffect = "none";
                    }
                })
                .on("drop", function (event) {
                    if (event.originalEvent.dataTransfer.files) {
                        event.stopPropagation();
                        event.preventDefault();
                    }
                });
        }
        
        function initProject() {
            ProjectManager.loadProject();

            // Open project button
            $("#btn-open-project").click(function () {
                ProjectManager.openProject();
            });

            // Handle toggling top level disclosure arrows of file list area
            $("#open-files-disclosure-arrow").click(function () {
                $(this).toggleClass("disclosure-arrow-closed");
                $("#open-files-container").toggle();
            });
            $("#project-files-disclosure-arrow").click(function () {
                $(this).toggleClass("disclosure-arrow-closed");
                $("#project-files-container").toggle();
            });
       
        }
        
        
        function initCommandHandlers() {
            FileCommandHandlers.init($("#main-toolbar .title"));
        }

        function initKeyBindings() {
            // Register keymaps and install the keyboard handler
            // TODO: (issue #268) show keyboard equivalents in the menus
            var _globalKeymap = KeyMap.create({
                "bindings": [
                    {"Ctrl-O": Commands.FILE_OPEN},
                    {"Ctrl-S": Commands.FILE_SAVE},
                    {"Ctrl-W": Commands.FILE_CLOSE},
                    {"Ctrl-R": Commands.FILE_RELOAD, "platform": "mac"},
                    {"F5"    : Commands.FILE_RELOAD, "platform": "win"}
                ],
                "platform": brackets.platform
            });
            KeyBindingManager.installKeymap(_globalKeymap);

            $(document.body).keydown(function (event) {
                if (KeyBindingManager.handleKey(KeyMap.translateKeyboardEvent(event))) {
                    event.preventDefault();
                }
            });
        }
        
        function initWindowListeners() {
            // TODO: (issue 269) to support IE, need to listen to document instead (and even then it may not work when focus is in an input field?)
            $(window).focus(function () {
                FileSyncManager.syncOpenDocuments();
            });
            
            $(window).unload(function () {
                CommandManager.execute(Commands.FILE_CLOSE_WINDOW);
            });
            
            $(window).contextmenu(function (e) {
                e.preventDefault();
            });
        }


        EditorManager.setEditorHolder($('#editorHolder'));
    
        initListeners();
        initProject();
        Menus.init();
        initCommandHandlers();
        initKeyBindings();
        initWindowListeners();
        
        PerfUtils.addMeasurement("Application Startup");
    });
    
});
