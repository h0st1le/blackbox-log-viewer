"use strict";

// Global Level Variables
var userSettings = {};

function BlackboxLogViewer() {
    function supportsRequiredAPIs() {
        return window.File && window.FileReader && window.FileList && Modernizr.canvas;
    }
    
    if (!supportsRequiredAPIs()) {
        alert("Your browser does not support the APIs required for reading log files.");
    }
    
    var
        GRAPH_STATE_PAUSED = 0,
        GRAPH_STATE_PLAY = 1,
        
        SMALL_JUMP_TIME = 100 * 1000,
        LARGE_JUMP_TIME = 1000 * 1000,
        PLAYBACK_MIN_RATE = 5,
        PLAYBACK_MAX_RATE = 300,
        PLAYBACK_DEFAULT_RATE = 100,
        PLAYBACK_RATE_STEP = 5,
        GRAPH_MIN_ZOOM = 10,
        GRAPH_MAX_ZOOM = 1000,
        GRAPH_DEFAULT_ZOOM = 100,
        GRAPH_ZOOM_STEP = 10;
    
    var
        graphState = GRAPH_STATE_PAUSED,
        currentBlackboxTime = 0,
        lastRenderTime = false,
        flightLog, flightLogDataArray,
        graph = null,
        
        prefs = new PrefStorage(),
        
        configuration = null,           					       // is their an associated dump file ?
        configurationDefaults = new ConfigurationDefaults(prefs),  // configuration defaults

        // User's video render config:
        videoConfig = {},
        
        // JSON graph configuration:
        graphConfig = {},
        

        offsetCache = [], // Storage for the offset cache (last 20 files)
        currentOffsetCache = {log:null, index:null, video:null, offset:null},

        // JSON array of graph configurations for New Workspaces feature
        lastGraphConfig = null,     // Undo feature - go back to last configuration.
        workspaceGraphConfigs = {}, // Workspaces
        bookmarkTimes	= [],		// Empty array for bookmarks (times)
        
        // Graph configuration which is currently in use, customised based on the current flight log from graphConfig
        activeGraphConfig = new GraphConfig(),
        
        graphLegend = null,
        fieldPresenter = FlightLogFieldPresenter,
        
        hasVideo = false, hasLog = false, hasMarker = false, // add measure feature
        hasTable = true, hasCraft = true, hasSticks = true, hasAnalyser, hasAnalyserFullscreen,
        hasAnalyserSticks = false, viewVideo = true, hasTableOverlay = false, hadTable,
        hasConfig = false, hasConfigOverlay = false,

        isFullscreen = false, // New fullscreen feature (to hide table)

        video = $(".log-graph video")[0],
        canvas = $("#graphCanvas")[0],
        analyserCanvas = $("#analyserCanvas")[0],
        analyserStickCanvas = $("#analyserStickCanvas")[0],
        craftCanvas = $("#craftCanvas")[0],
        videoURL = false,
        videoOffset = 0.0,
        
        videoExportInTime = false,
        videoExportOutTime = false,

        markerTime = 0, // New marker time
        
        graphRendersCount = 0,
        
        seekBarCanvas = $(".log-seek-bar canvas")[0],
        seekBar = new SeekBar(seekBarCanvas),
        
        seekBarRepaintRateLimited = $.throttle(200, $.proxy(seekBar.repaint, seekBar)),
        
        updateValuesChartRateLimited,
        
        animationFrameIsQueued = false,
        
        playbackRate = PLAYBACK_DEFAULT_RATE,
        
        graphZoom = GRAPH_DEFAULT_ZOOM,
        lastGraphZoom = GRAPH_DEFAULT_ZOOM; // QuickZoom function.
    
    function blackboxTimeFromVideoTime() {
        return (video.currentTime - videoOffset) * 1000000 + flightLog.getMinTime();
    }
    
    function syncLogToVideo() {
        if (hasLog) {
            currentBlackboxTime = blackboxTimeFromVideoTime();
        }
    }
    
    function setVideoOffset(offset, withoutRefresh) { // optionally prevent the graph refresh until later
        videoOffset = offset;
        
        /* 
         * Round to 2 dec places for display and put a plus at the start for positive values to emphasize the fact it's
         * an offset
         */
        $(".video-offset").val((videoOffset >= 0 ? "+" : "") + (videoOffset.toFixed(3) != videoOffset ? videoOffset.toFixed(3) : videoOffset));
        
        if (withoutRefresh) invalidateGraph();
    }
    
    function isInteger(value) {
        return (value | 0) == value || Math.trunc(value) == value;
    }
    
    function atMost2DecPlaces(value) {
        if (isInteger(value))
            return value; //it's an integer already
    
        if (value === null)
            return "(absent)";
        
        return value.toFixed(2);
    }
    
    function updateValuesChart() {
        var 
            table = $(".log-field-values table"),
            i,
            frame = flightLog.getSmoothedFrameAtTime(currentBlackboxTime),
            fieldNames = flightLog.getMainFieldNames();
        
        $("tr:not(:first)", table).remove();

        if (frame) {

            var currentFlightMode = frame[flightLog.getMainFieldIndexByName("flightModeFlags")];

            if(hasTable) { // Only redraw the table if it is enabled

                var 
                    rows = [],
                    rowCount = Math.ceil(fieldNames.length / 2);

                for (i = 0; i < rowCount; i++) {
                    var 
                        row = 
                            "<tr>" +
                            '<td>' + fieldPresenter.fieldNameToFriendly(fieldNames[i]) + '</td>' +
                            '<td class="raw-value">' + atMost2DecPlaces(frame[i]) + '</td>' +
                            '<td>' + fieldPresenter.decodeFieldToFriendly(flightLog, fieldNames[i], frame[i], currentFlightMode) + "</td>",

                        secondColumn = i + rowCount;

                    if (secondColumn < fieldNames.length) {
                        row += 
                            '<td>' + fieldPresenter.fieldNameToFriendly(fieldNames[secondColumn]) + '</td>' +
                            '<td>' + atMost2DecPlaces(frame[secondColumn]) + '</td>' +
                            '<td>' + fieldPresenter.decodeFieldToFriendly(flightLog, fieldNames[secondColumn], frame[secondColumn], currentFlightMode) + '</td>';
                    }

                    row += "</tr>";

                    rows.push(row);
                }

                table.append(rows.join(""));
                
            }

            // Update flight mode flags on status bar
            $("#status-bar .flight-mode").text(
            		fieldPresenter.decodeFieldToFriendly(null, 'flightModeFlags', currentFlightMode, null)	
            	);

            // update time field on status bar
            $(".graph-time").val(formatTime((currentBlackboxTime-flightLog.getMinTime())/1000, true));
            if(hasMarker) {
                $("#status-bar .marker-offset").text('Marker Offset ' + formatTime((currentBlackboxTime-markerTime)/1000, true) + 'ms ' + (1000000/(currentBlackboxTime-markerTime)).toFixed(0) + "Hz");
            }

            
            // Update the Legend Values
            if(graphLegend) graphLegend.updateValues(flightLog, frame);
        }
    }
    
    updateValuesChartRateLimited = $.throttle(250, updateValuesChart);
    
    function animationLoop() {
        var 
            now = Date.now();
        
        if (!graph) {
            animationFrameIsQueued = false;
            return;
        }
        
        if (hasVideo) {
            currentBlackboxTime = blackboxTimeFromVideoTime();
        } else if (graphState == GRAPH_STATE_PLAY) {
            var
                delta;
            
            if (lastRenderTime === false) {
                delta = 0;
            } else {
                delta = Math.floor((now - lastRenderTime) * 1000 * playbackRate / 100);
            }
    
            currentBlackboxTime += delta;
    
            if (currentBlackboxTime > flightLog.getMaxTime()) {
                currentBlackboxTime = flightLog.getMaxTime();
                setGraphState(GRAPH_STATE_PAUSED);
            }
        }
        
        graph.render(currentBlackboxTime);
        graphRendersCount++;
        
        seekBar.setCurrentTime(currentBlackboxTime);
    
        updateValuesChartRateLimited();
        
        if (graphState == GRAPH_STATE_PLAY) {
            lastRenderTime = now;
            
            seekBarRepaintRateLimited();
            
            animationFrameIsQueued = true;
            requestAnimationFrame(animationLoop);
        } else {
            seekBar.repaint();
            
            animationFrameIsQueued = false;
        }
    }
    
    function invalidateGraph() {
        if (!animationFrameIsQueued) {
            animationFrameIsQueued = true;
            requestAnimationFrame(animationLoop);
        }
    }
    
    function updateCanvasSize() {
        var
            width = $(canvas).width(),
            height = $(canvas).height();
        
        if (graph) {
            graph.resize(width, height);
            seekBar.resize(canvas.offsetWidth, 50);
            
            invalidateGraph();
        }
    }
    
    function renderLogFileInfo(file) {
        $(".log-filename").text("Cleanflight Blackbox Explorer " + file.name);
        
        var 
            logIndexContainer = $(".log-index"),
            logIndexPicker,
            logCount = flightLog.getLogCount(),
            index;
        
        logIndexContainer.empty();
        
        if (logCount > 1) {
            logIndexPicker = $('<select class="log-index form-control">');
            
            logIndexPicker.change(function() {
                selectLog(parseInt($(this).val(), 10));
            });
        }
        
        for (index = 0; index < logCount; index++) {
            var
                logLabel,
                option, holder,
                error;
            
            error = flightLog.getLogError(index);
            
            if (error) {
                logLabel = "Error: " + error;
            } else {
                logLabel = formatTime(flightLog.getMinTime(index) / 1000, false) 
                    + " - " + formatTime(flightLog.getMaxTime(index) / 1000 , false)
                    + " [" + formatTime(Math.ceil((flightLog.getMaxTime(index) - flightLog.getMinTime(index)) / 1000), false) + "]";
            }
            
            if (logCount > 1) {
                option = $("<option></option>");
            
                option.text((index + 1) + "/" + (flightLog.getLogCount()) + ": " + logLabel);
                option.attr("value", index);
                
                if (error)
                    option.attr("disabled", "disabled");
                
                logIndexPicker.append(option);
            } else {
                holder = $('<div class="form-control-static"></div>');
                
                holder.text(logLabel);
                logIndexContainer.append(holder);
            }
        }
    
        if (logCount > 1) {
            logIndexPicker.val(0);
            logIndexContainer.append(logIndexPicker);
        }
    }
    
    /**
     * Update the metadata displays to show information about the currently selected log index.
     */
    function renderSelectedLogInfo() {
        $(".log-index").val(flightLog.getLogIndex());
                
        if (flightLog.getNumCellsEstimate()) {
            $(".log-cells").text(flightLog.getNumCellsEstimate() + "S (" + Number(flightLog.getReferenceVoltageMillivolts() / 1000).toFixed(2) + "V)");
            $(".log-cells-header,.log-cells").css('display', 'block');
        } else {
            $(".log-cells-header,.log-cells").css('display', 'none');
        }
        
        if (flightLog.getSysConfig().deviceUID != null) {
            $(".log-device-uid").text(flightLog.getSysConfig().deviceUID);
            $(".log-device-uid-header,.log-device-uid").css('display', 'block');
        } else {
           $(".log-device-uid-header,.log-device-uid").css('display', 'none');
        }
        
        // Add log version information to status bar
        var sysConfig = flightLog.getSysConfig();
        $('#status-bar .version').text( ((sysConfig['Firmware revision']!=null)?(sysConfig['Firmware revision']):''));
        $('#status-bar .looptime').text( ((sysConfig['loopTime']!=null)?(sysConfig['loopTime'] +'us (' + (1000000/sysConfig['loopTime']).toFixed(0) + 'Hz)'):''));
        $('#status-bar .lograte').text( ((sysConfig['frameIntervalPDenom']!=null && sysConfig['frameIntervalPNum']!=null)?( 'Logging Sample Rate : ' + sysConfig['frameIntervalPNum'] +'/' + sysConfig['frameIntervalPDenom']):''));

        seekBar.setTimeRange(flightLog.getMinTime(), flightLog.getMaxTime(), currentBlackboxTime);
        seekBar.setActivityRange(flightLog.getSysConfig().minthrottle, flightLog.getSysConfig().maxthrottle);
        
        var 
            activity = flightLog.getActivitySummary();
        
        seekBar.setActivity(activity.times, activity.avgThrottle, activity.hasEvent);
        
        seekBar.repaint();
    }
    
    function setGraphState(newState) {
        graphState = newState;
        
        lastRenderTime = false;
        
        switch (newState) {
            case GRAPH_STATE_PLAY:
                if (hasVideo) {
                    video.play();
                }
                $(".log-play-pause span").attr('class', 'glyphicon glyphicon-pause');
            break;
            case GRAPH_STATE_PAUSED:
                if (hasVideo) {
                    video.pause();
                }
                $(".log-play-pause span").attr('class', 'glyphicon glyphicon-play');
            break;
        }
        
        invalidateGraph();
    }
    
    function setCurrentBlackboxTime(newTime) {
        if (hasVideo) {
            video.currentTime = (newTime - flightLog.getMinTime()) / 1000000 + videoOffset;
        
            syncLogToVideo();
        } else {
            currentBlackboxTime = newTime;
        }
        
        invalidateGraph();
    }
    
    function setVideoTime(newTime) {
        video.currentTime = newTime;
    
        syncLogToVideo();
    }
    
    function setVideoInTime(inTime) {
        videoExportInTime = inTime;
        
        if (seekBar) {
            seekBar.setInTime(videoExportInTime);
        }
        
        if (graph) {
            graph.setInTime(videoExportInTime);
            invalidateGraph();
        }
    }
    
    function setVideoOutTime(outTime) {
        videoExportOutTime = outTime;
        
        if (seekBar) {
            seekBar.setOutTime(videoExportOutTime);
        }
        
        if (graph) {
            graph.setOutTime(videoExportOutTime);
            invalidateGraph();
        }
    }
    
    function setPlaybackRate(rate) {
        if (rate >= PLAYBACK_MIN_RATE && rate <= PLAYBACK_MAX_RATE) {
              playbackRate = rate;
              
              if (video) {
                  video.playbackRate = rate / 100;
              }
        }
    }
    
    function setGraphZoom(zoom) {
        if (zoom == null) { // go back to last zoom value
            zoom = lastGraphZoom;
        }
        if (zoom >= GRAPH_MIN_ZOOM && zoom <= GRAPH_MAX_ZOOM) {
            lastGraphZoom = graphZoom;
            graphZoom = zoom;
            
            if (graph) {
                graph.setGraphZoom(zoom / 100);
                invalidateGraph();
            }
        }
    }
    
    function showConfigFile(state) {
            if(hasConfig) {
                if(state == null) { // no state specified, just toggle
                    hasConfigOverlay = !hasConfigOverlay;
                } else { //state defined, just set item
                    hasConfigOverlay = (state)?true:false;
                }
                (hasConfigOverlay)?$("html").addClass("has-config-overlay"):$("html").removeClass("has-config-overlay");
            }
        }

    /**
     * Set the index of the log from the log file that should be viewed. Pass "null" as the index to open the first
     * available log.
     */
    function selectLog(logIndex) {
        var
            success = false;
        
        try {
            if (logIndex === null) {
                for (var i = 0; i < flightLog.getLogCount(); i++) {
                    if (flightLog.openLog(i)) {
                        success = true;
                        currentOffsetCache.index = i;
                        break;
                    }
                }
                
                if (!success) {
                    throw "No logs in this file could be parsed successfully";
                }
            } else {
                flightLog.openLog(logIndex);
                currentOffsetCache.index = logIndex;
            }
        } catch (e) {
            alert("Error opening log: " + e);
            currentOffsetCache.index = null;
            return;
        }
        
        if (graph) {
            graph.destroy();
        }
        
        var graphOptions = {
            drawAnalyser:true,              // add an analyser option
            analyserSampleRate:2000/*Hz*/,  // the loop time for the log
            };

        if((flightLog.getSysConfig().loopTime             != null) &&
            (flightLog.getSysConfig().frameIntervalPNum   != null) &&
            (flightLog.getSysConfig().frameIntervalPDenom != null) ) {
                graphOptions.analyserSampleRate = 1000000 / (flightLog.getSysConfig().loopTime * flightLog.getSysConfig().frameIntervalPDenom / flightLog.getSysConfig().frameIntervalPNum);
                }

        graph = new FlightLogGrapher(flightLog, activeGraphConfig, canvas, craftCanvas, analyserCanvas, graphOptions);
        
        setVideoInTime(false);
        setVideoOutTime(false);
    
        activeGraphConfig.adaptGraphs(flightLog, graphConfig);
        
        graph.onSeek = function(offset) {
            //Seek faster
            offset *= 2;
            
            if (hasVideo) {
                setVideoTime(video.currentTime + offset / 1000000);
            } else {
                setCurrentBlackboxTime(currentBlackboxTime + offset);
            }
            invalidateGraph();
        };
        
        if (hasVideo) {
            syncLogToVideo();
        } else {
            // Start at beginning:
            currentBlackboxTime = flightLog.getMinTime();
        }
        
        renderSelectedLogInfo();
        
        updateCanvasSize();
        
        setGraphState(GRAPH_STATE_PAUSED);
        setGraphZoom(graphZoom);
    }
    
    function loadLogFile(file) {
        var reader = new FileReader();
    
        reader.onload = function(e) {
            var bytes = e.target.result;
            
            var fileContents = String.fromCharCode.apply(null, new Uint8Array(bytes, 0,100));

            if(fileContents.match(/# dump/i)) { // this is actually a configuration file
                try{

                   // Firstly, is this a configuration defaults file
                   // (the filename contains the word 'default')

                   if( (file.name).match(/default/i) ) {
                        configurationDefaults.loadFile(file);
                   } else {

                       configuration = new Configuration(file, configurationDefaults, showConfigFile); // the configuration class will actually re-open the file as a text object.
                       hasConfig = true;
                       (hasConfig)?$("html").addClass("has-config"):$("html").removeClass("has-config");
                   }
                   
                   } catch(e) {
                       configuration = null;
                       hasConfig = false;
                   }
               return;            
            }

            flightLogDataArray = new Uint8Array(bytes);
            
            try {
                flightLog = new FlightLog(flightLogDataArray);
            } catch (err) {
                alert("Sorry, an error occured while trying to open this log:\n\n" + err);
                return;
            }
            
            renderLogFileInfo(file);
            currentOffsetCache.log      = file.name; // store the name of the loaded log file
            currentOffsetCache.index    = null;      // and clear the index
            
            hasLog = true;
            $("html").addClass("has-log");
            (hasCraft)?$("html").addClass("has-craft"):$("html").removeClass("has-craft");
            (hasTable)?$("html").addClass("has-table"):$("html").removeClass("has-table");
            (hasSticks)?$("html").addClass("has-sticks"):$("html").removeClass("has-sticks");
            
            selectLog(null);
        };
    
        reader.readAsArrayBuffer(file);
    }
    
    function loadVideo(file) {
        currentOffsetCache.video = file.name; // store the name of the loaded video
        if (videoURL) {
            URL.revokeObjectURL(videoURL);
            videoURL = false;
        }
        
        if (!URL.createObjectURL) {
            alert("Sorry, your web browser doesn't support showing videos from your local computer. Try Google Chrome instead.");
            currentOffsetCache.video = null; // clear the associated video name
            return;
        }
            
        videoURL = URL.createObjectURL(file);
        video.volume = 0.05;
        video.src = videoURL;
        
        // Reapply the last playbackRate to the new video
        setPlaybackRate(playbackRate);
    }
    
    function videoLoaded(e) {
        hasVideo = true;
        
        $("html").addClass("has-video");
        
        setGraphState(GRAPH_STATE_PAUSED);
    }
    
    function reportVideoError(e) {
        alert("Your video could not be loaded, your browser might not support this kind of video. Try Google Chrome instead.");
    }
    
    function onLegendVisbilityChange(hidden) {
        prefs.set('log-legend-hidden', hidden);
        updateCanvasSize();
    }

    function onLegendSelectionChange() {
            hasAnalyser = true;
            graph.setDrawAnalyser(hasAnalyser);            
            (hasAnalyser)?$("html").addClass("has-analyser"):$("html").removeClass("has-analyser");       
            prefs.set('hasAnalyser', hasAnalyser);
            invalidateGraph();
    }

    function setMarker(state) { // update marker field
        hasMarker = state;
        (state)?$("html").addClass("has-marker"):$("html").removeClass("has-marker");       
    }

    function setFullscreen(state) { // update fullscreen status
        isFullscreen = state;
        (state)?$("html").addClass("is-fullscreen"):$("html").removeClass("is-fullscreen");       
    }
    
    this.getMarker = function() { // get marker field
        return {
            state:hasMarker,
            time:markerTime
            };
    }
    
    this.getBookmarks = function() { // get bookmark events
    	var bookmarks = [];
    	try {
    		if(bookmarkTimes!=null) {
		    	for(var i=0; i<=9; i++) {
		    		if(bookmarkTimes[i]!=null) {
			    		bookmarks[i] = {
			    			state: (bookmarkTimes[i]!=0),
			    			time:  bookmarkTimes[i]
			    			};
			    		} else bookmarks[i] = null;
		    	}
    		}
	    	return bookmarks;	    		
    	} catch(e) {
    		return null;
    	}
    }
           
    prefs.get('videoConfig', function(item) {
        if (item) {
            videoConfig = item;
        } else {
            videoConfig = {
                width: 1280,
                height: 720,
                frameRate: 30,
                videoDim: 0.4
            };
        }
    });
    
    prefs.get('graphConfig', function(item) {
        graphConfig = GraphConfig.load(item);
        
        if (!graphConfig) {
            graphConfig = GraphConfig.getExampleGraphConfigs(flightLog, ["Motors", "Gyros"]);
        }
    });
    
    prefs.get('userSettings', function(item) {
		if(item) {
	    			userSettings = item;
				 } else {
					 userSettings = { // default settings
							 		customMix: null
					 	 			};
				 }
    	});

    // Workspace save/restore to/from file.
    function saveWorkspaces(file) {

        var data; // Data to save

        if(!workspaceGraphConfigs) return null;     // No workspaces to save
        if(!file) file = 'workspaces.json'; // No filename to save to, make one up

        if(typeof workspaceGraphConfigs === "object"){
            data = JSON.stringify(workspaceGraphConfigs, undefined, 4);
        }

        var blob = new Blob([data], {type: 'text/json'}),
            e    = document.createEvent('MouseEvents'),
            a    = document.createElement('a');

        a.download = file;
        a.href = window.URL.createObjectURL(blob);
        a.dataset.downloadurl =  ['text/json', a.download, a.href].join(':');
        e.initMouseEvent('click', true, false, window, 0, 0, 0, 0, 0, false, false, false, false, 0, null);
        a.dispatchEvent(e);

    }

    function loadWorkspaces(file) {

        var reader = new FileReader();
    
        reader.onload = function(e) {

            var data = e.target.result;
            workspaceGraphConfigs = JSON.parse(data);
            prefs.set('workspaceGraphConfigs', workspaceGraphConfigs);      // Store to local cache
 
            window.alert('Workspaces Loaded')                       
        };
     
        reader.readAsText(file);
    }

    // New workspaces feature; local storage of user configurations
    prefs.get('workspaceGraphConfigs', function(item) {
        if(item) {
            workspaceGraphConfigs = item;
            } else {
            workspaceGraphConfigs = {graphConfig : [
                                    null,null,null,null,null,null,null,null,null,null
                                    ]};
            }
    });

    // Get the offsetCache buffer
    prefs.get('offsetCache', function(item) {
        if(item) {
            offsetCache = item;
        }
    })
    
    activeGraphConfig.addListener(function() {
        invalidateGraph();
    });
    
    $(document).ready(function() {
        graphLegend = new GraphLegend($(".log-graph-legend"), activeGraphConfig, onLegendVisbilityChange, onLegendSelectionChange, zoomGraphConfig, expandGraphConfig);
        
        prefs.get('log-legend-hidden', function(item) {
            if (item) {
                graphLegend.hide();
            }
        });

        prefs.get('hasCraft', function(item) {
           if (item) {
               hasCraft = item;
               (hasCraft)?$("html").addClass("has-craft"):$("html").removeClass("has-craft");       
           } 
        });

        prefs.get('hasSticks', function(item) {
           if (item) {
               hasSticks = item;
               (hasSticks)?$("html").addClass("has-sticks"):$("html").removeClass("has-sticks");  
           } 
        });


        prefs.get('hasTable', function(item) {
           if (item) {
               hasTable = item;
               (hasTable)?$("html").addClass("has-table"):$("html").removeClass("has-table");       
           } 
        });
        
        prefs.get('hasAnalyser', function(item) {
           if (item) {
               hasAnalyser = item;
               (hasAnalyser)?$("html").addClass("has-analyser"):$("html").removeClass("has-analyser");       
           } 
        });

        $(".file-open").change(function(e) {
            var 
                files = e.target.files,
                i;

            for (i = 0; i < files.length; i++) {
                var
                    isLog = files[i].name.match(/\.(TXT|CFL|LOG)$/i),
                    isVideo = files[i].name.match(/\.(AVI|MOV|MP4|MPEG)$/i),
                    isWorkspaces = files[i].name.match(/\.(JSON)$/i);
                
                if (!isLog && !isVideo && !isWorkspaces) {
                    if (files[i].size < 10 * 1024 * 1024)
                        isLog = true; //Assume small files are logs rather than videos
                    else
                        isVideo = true;
                }
                
                if (isLog) {
                    loadLogFile(files[i]);
                } else if (isVideo) {
                    loadVideo(files[i]);
                } else if (isWorkspaces) {
                    loadWorkspaces(files[i])
                }
            }

            // finally, see if there is an offsetCache value already, and auto set the offset
            for(i=0; i<offsetCache.length; i++) {
                if(
                    (currentOffsetCache.log   == offsetCache[i].log)   &&
                    (currentOffsetCache.index == offsetCache[i].index) &&
                    (currentOffsetCache.video == offsetCache[i].video)    ) {
                        setVideoOffset(offsetCache[i].offset, true);
                    }

            }
        });
        
        // New View Controls
        $(".view-video").click(function() {
            viewVideo = !viewVideo;
            (!viewVideo)?$("html").addClass("video-hidden"):$("html").removeClass("video-hidden");       
        });

        $(".view-craft").click(function() {
            hasCraft = !hasCraft;
            (hasCraft)?$("html").addClass("has-craft"):$("html").removeClass("has-craft");       
            prefs.set('hasCraft', hasCraft);
        });

        $(".view-sticks").click(function() {
            hasSticks = !hasSticks;
            graph.setDrawSticks(hasSticks);            
            (hasSticks)?$("html").addClass("has-sticks"):$("html").removeClass("has-sticks");  
            prefs.set('hasSticks', hasSticks);
            invalidateGraph();
        });
        
        $(".view-table").click(function() {
            hasTable = !hasTable;
            (hasTable)?$("html").addClass("has-table"):$("html").removeClass("has-table");       
            prefs.set('hasTable', hasTable);
        });
       
        $(".view-analyser-sticks").click(function() {
            hasAnalyserSticks = !hasAnalyserSticks;
            (hasAnalyserSticks)?$("html").addClass("has-analyser-sticks"):$("html").removeClass("has-analyser-sticks");       
            prefs.set('hasAnalyserSticks', hasAnalyserSticks);
        });

        $(".view-analyser").click(function() {
            if(activeGraphConfig.selectedFieldName != null) {
                hasAnalyser = !hasAnalyser; 
            } else hasAnalyser = false;
            graph.setDrawAnalyser(hasAnalyser);            
            (hasAnalyser)?$("html").addClass("has-analyser"):$("html").removeClass("has-analyser");       
            prefs.set('hasAnalyser', hasAnalyser);
            invalidateGraph();
        });

        $(".view-analyser-fullscreen").click(function() {
            if(hasAnalyser) {
                hasAnalyserFullscreen = !hasAnalyserFullscreen; 
            } else hasAnalyserFullscreen = false;
            (hasAnalyserFullscreen)?$("html").addClass("has-analyser-fullscreen"):$("html").removeClass("has-analyser-fullscreen");       
            graph.setAnalyser(hasAnalyserFullscreen);
            invalidateGraph();
        });

        var logJumpBack = function(fast) {
            var scrollTime = SMALL_JUMP_TIME;
            if(fast!=null) scrollTime = (fast!=0)?(graph.getWindowWidthTime() * fast):SMALL_JUMP_TIME;
            if (hasVideo) {
                setVideoTime(video.currentTime - scrollTime / 1000000);
            } else {
                setCurrentBlackboxTime(currentBlackboxTime - scrollTime);
            }
            
            setGraphState(GRAPH_STATE_PAUSED);
        };
        $(".log-jump-back").click(function() {logJumpBack(false);});

        var logJumpForward = function(fast) {
            var scrollTime = SMALL_JUMP_TIME;
            if(fast!=null) scrollTime = (fast!=0)?(graph.getWindowWidthTime() * fast):SMALL_JUMP_TIME;
            if (hasVideo) {
                setVideoTime(video.currentTime + scrollTime / 1000000);
            } else {
                setCurrentBlackboxTime(currentBlackboxTime + scrollTime);
            }
            
            setGraphState(GRAPH_STATE_PAUSED);
        };
        $(".log-jump-forward").click(function() {logJumpForward(false);});
        
        var logJumpStart = function() {
            setCurrentBlackboxTime(flightLog.getMinTime());
            setGraphState(GRAPH_STATE_PAUSED);
        };
        $(".log-jump-start").click(logJumpStart);
    
        var logJumpEnd = function() {
            setCurrentBlackboxTime(flightLog.getMaxTime());
            setGraphState(GRAPH_STATE_PAUSED);
        };
        $(".log-jump-end").click(logJumpEnd);
        
        var videoJumpStart = function() {
            setVideoTime(0);
            setGraphState(GRAPH_STATE_PAUSED);
        };
        $(".video-jump-start").click(videoJumpStart);
    
        var videoJumpEnd = function() {
            if (video.duration) {
                setVideoTime(video.duration);
                setGraphState(GRAPH_STATE_PAUSED);
            }
        };
        $(".video-jump-end").click(videoJumpEnd);

        var logPlayPause = function() {
            if (graphState == GRAPH_STATE_PAUSED) {
                setGraphState(GRAPH_STATE_PLAY);
            } else {
                setGraphState(GRAPH_STATE_PAUSED);
            }            
        };  
        $(".log-play-pause").click(logPlayPause);
        
        var logSyncHere = function() {
            setVideoOffset(video.currentTime);
        };
        $(".log-sync-here").click(logSyncHere);
        
        var logSyncBack = function() {
            setVideoOffset(videoOffset - 1 / 15);
        };
        $(".log-sync-back").click(logSyncBack);
    
        var logSyncForward = function() {
            setVideoOffset(videoOffset + 1 / 15);
        };
        $(".log-sync-forward").click(logSyncForward);
    
        $(".video-offset").change(function() {
            var offset = parseFloat($(".video-offset").val());
            
            if (!isNaN(offset)) {
                videoOffset = offset;                
                // Store the video offset to the local cache
                currentOffsetCache.offset = offset;
                if(hasLog && hasVideo) {
                    if(offsetCache.length > 20) offsetCache.shift();
                    offsetCache.push(currentOffsetCache);
                    prefs.set('offsetCache', offsetCache);
                }
                invalidateGraph();
            }
        });

        // Add user configurable start time
        $(".graph-time").change(function() {

            // the log is offset by the minTime
            var newTime = stringTimetoMsec($(".graph-time").val());
                   
            if (!isNaN(newTime)) {
                if (hasVideo) {
                    setVideoTime(newTime / 1000000 + videoOffset);
                } else {
                    newTime += flightLog.getMinTime();
                    setCurrentBlackboxTime(newTime);
                }
                invalidateGraph();               
            }
        });
       
        var newGraphConfig = function(newConfig) {
                lastGraphConfig = graphConfig; // Remember the last configuration.
                graphConfig = newConfig;
                
                activeGraphConfig.adaptGraphs(flightLog, graphConfig);
                
                prefs.set('graphConfig', graphConfig);            
        }

        function expandGraphConfig(index) { // Put each of the fields into a seperate graph

            var expandedGraphConfig = [];

            for(var i=0; i< graphConfig[index].fields.length; i++) {                    // Loop through each of the fields
            var singleGraph = {fields: [], label:'', height: 1 };
                singleGraph.fields.push(graphConfig[index].fields[i]);
                singleGraph.label = graphConfig[index].fields[i].name;
                expandedGraphConfig.push(singleGraph);
            }
            
            newGraphConfig(expandedGraphConfig);
            invalidateGraph();

        }

        function zoomGraphConfig(index) { // Put each of the fields onto one graph and clear the others

            if(graphConfig.length == 1) { // if there is only one graph, then return to previous configuration
                if (lastGraphConfig != null) {
                    newGraphConfig(lastGraphConfig);
                }
            } else {

                var expandedGraphConfig = [];
                var singleGraph = {fields: [], label:'', height: 1 };


                for(var i=0; i< graphConfig[index].fields.length; i++) {                    // Loop through each of the fields
                    singleGraph.fields.push(graphConfig[index].fields[i]);
                    singleGraph.label = graphConfig[index].label;
                }
                expandedGraphConfig.push(singleGraph);

                newGraphConfig(expandedGraphConfig);
            }
            invalidateGraph();

        }
        
        var 
            graphConfigDialog = new GraphConfigurationDialog($("#dlgGraphConfiguration"), function(newConfig) {
                newGraphConfig(newConfig);   
            }),
            
            headerDialog = new HeaderDialog($("#dlgHeaderDialog"), function(newSysConfig) {
                if(newSysConfig!=null) {
                    prefs.set('lastHeaderData', newSysConfig);
                    flightLog.setSysConfig(newSysConfig);

                    // Save Current Position then re-calculate all the log information
                    var activePosition = (hasVideo)?video.currentTime:currentBlackboxTime;
                    
                    selectLog(null);
                    if (hasVideo) {
                        setVideoTime(activePosition);
                    } else {
                        setCurrentBlackboxTime(activePosition);
                    }
                }
            }),

            keysDialog = new KeysDialog($("#dlgKeysDialog")),
            
            userSettingsDialog = new UserSettingsDialog($("#dlgUserSettings"), function(newSettings) {
	            userSettings = newSettings;

	            prefs.set('userSettings', newSettings);

	            // refresh the craft model
	            if(graph!=null) {
	                graph.initializeCraftModel();
	                invalidateGraph();
	            }

	        }),

	        exportDialog = new VideoExportDialog($("#dlgVideoExport"), function(newConfig) {
	            videoConfig = newConfig;
	            
	            prefs.set('videoConfig', newConfig);
	        });
        
        
        $(".open-graph-configuration-dialog").click(function(e) {
            e.preventDefault();
            
            graphConfigDialog.show(flightLog, graphConfig);
        });

        $(".open-header-dialog").click(function(e) {
            e.preventDefault();
            
            headerDialog.show(flightLog.getSysConfig());
        });

        $(".open-keys-dialog").click(function(e) {
            e.preventDefault();
            
            keysDialog.show();
        });

        $(".open-user-settings-dialog").click(function(e) {
            e.preventDefault();
            
            userSettingsDialog.show(flightLog, userSettings);
        });

        $("#status-bar .marker-offset").click(function(e) {
	        setCurrentBlackboxTime(markerTime);
	        invalidateGraph(); 
        });
        
        $('#status-bar .bookmark-1').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[1]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-2').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[2]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-3').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[3]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-4').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[4]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-5').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[5]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-6').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[6]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-7').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[7]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-8').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[8]);
	        invalidateGraph(); 
        });
                
        $('#status-bar .bookmark-9').click(function(e) {
	        setCurrentBlackboxTime(bookmarkTimes[9]);
	        invalidateGraph(); 
        });

        $('#status-bar .bookmark-clear').click(function(e) {
            bookmarkTimes = null;
            for(var i=1; i<=9; i++) {
                $('#status-bar .bookmark-'+ i).css('visibility', 'hidden' );
            }
            $('#status-bar .bookmark-clear').css('visibility', 'hidden' );
	        invalidateGraph(); 
        });

        $('#status-bar .configuration-file-name').click(function(e) {
            showConfigFile(true); // show the config file
            e.preventDefault();
        });

        $(".btn-workspaces-export").click(function(e) {
            setGraphState(GRAPH_STATE_PAUSED);
            saveWorkspaces();
            e.preventDefault();
        });
        
                
        if (FlightLogVideoRenderer.isSupported()) {
            $(".btn-video-export").click(function(e) {
                setGraphState(GRAPH_STATE_PAUSED);
    
                exportDialog.show(flightLog, {
                    graphConfig: activeGraphConfig,
                    inTime: videoExportInTime,
                    outTime: videoExportOutTime,
                    flightVideo: (hasVideo && viewVideo) ? video.cloneNode() : false,
                    flightVideoOffset: videoOffset,
                    hasCraft: hasCraft,
                    hasAnalyser: hasAnalyser,
                    hasSticks: hasSticks
                }, videoConfig);
                
                e.preventDefault();
            });
        } else {
            $(".btn-video-export")
                .addClass('disabled')
                .css('pointer-events', 'all !important')
                .attr({
                    'data-toggle': 'tooltip',
                    'data-placement': 'bottom',
                    'title': "Not supported by your browser, use Google Chrome instead"
                })
                .tooltip();
        }

        $(window).resize(updateCanvasSize);
        
        $(document).on("mousewheel", function(e) {
        if (graph && $(e.target).parents('.modal').length == 0 && $(e.target).attr('id') == 'graphCanvas') {
                var delta = Math.max(-1, Math.min(1, (e.originalEvent.wheelDelta)));
                if(delta<0) { // scroll down (or left)
                    if (e.altKey || e.shiftKey) {
                        setGraphZoom(graphZoom - 10.0 - ((e.altKey)?15.0:0.0));
                        $(".graph-zoom").val(graphZoom + "%");
                    } else {
                      logJumpBack(0.1 /*10%*/);
                    }
                } else { // scroll up or right
                    if (e.altKey || e.shiftKey) {
                        setGraphZoom(graphZoom + 10.0 + ((e.altKey)?15.0:0.0));
                        $(".graph-zoom").val(graphZoom + "%");
                    } else {
                        logJumpForward(0.1 /*10%*/);
                    }
                }
                e.preventDefault();
            }
        });

        $(document).keydown(function(e) {
            var shifted = (e.altKey || e.shiftKey || e.ctrlKey || e.metaKey);
            if(e.which === 13 && e.target.type === 'text' && $(e.target).parents('.modal').length == 0) {
                // pressing return on a text field clears the focus.
                $(e.target).blur();                
            }
            // keyboard controls are disabled on modal dialog boxes and text entry fields
            if (graph && e.target.type != 'text' && $(e.target).parents('.modal').length == 0) {
                switch (e.which) {
                    case "I".charCodeAt(0):
                        if (!(shifted)) {
                            if (videoExportInTime === currentBlackboxTime) {
                                setVideoInTime(false)
                            } else {
                                setVideoInTime(currentBlackboxTime);
                            }
                        }
                        
                        e.preventDefault();
                    break;
                    case "O".charCodeAt(0):
                        if (!(shifted)) {
                            if (videoExportOutTime === currentBlackboxTime) {
                                setVideoOutTime(false);
                            } else {
                                setVideoOutTime(currentBlackboxTime);
                            }
                        }                        
                        e.preventDefault();
                    break;
                    case "M".charCodeAt(0): 
                        if (e.altKey && hasMarker && hasVideo && hasLog) { // adjust the video sync offset and remove marker
                          try{
                            setVideoOffset(videoOffset + (stringTimetoMsec($("#status-bar .marker-offset").text()) / 1000000), true);  
                          } catch(e) {
                             console.log('Failed to set video offset');
                          }
                        } else { // Add a marker to graph window
                            markerTime = currentBlackboxTime;
                            $("#status-bar .marker-offset").text('Marker Offset ' + formatTime(0) + 'ms');
                            
                        }                        
                        setMarker(!hasMarker);
                        $("#status-bar .marker-offset").css('visibility', (hasMarker)?'visible':'hidden');
                        invalidateGraph();
                        e.preventDefault();
                    break;

                    case "C".charCodeAt(0): 
                        showConfigFile(); // toggle the config file popup
                        e.preventDefault();
                    break;

                    case "T".charCodeAt(0):
                        hasTableOverlay = !hasTableOverlay;
                    	(hasTableOverlay)?$("html").addClass("has-table-overlay"):$("html").removeClass("has-table-overlay");

                        if (hasTableOverlay) hadTable = hasTable; // Store the state of the table view when quickshow selected

                    	if (hasTableOverlay && !hasTable) { 
                    		hasTable = true; // force display the table if it is off when we quickshow.
                    		}
                		if (!hasTableOverlay && !hadTable) {
                    		hasTable = false; // return table state when we remove quickshow.
                    		}

                    	(hasTable)?$("html").addClass("has-table"):$("html").removeClass("has-table");
                    	invalidateGraph();
                        e.preventDefault();
                    break;

                    // Workspace shortcuts
                    case "0".charCodeAt(0):
                    case "1".charCodeAt(0):
                    case "2".charCodeAt(0):
                    case "3".charCodeAt(0):
                    case "4".charCodeAt(0):
                    case "5".charCodeAt(0):
                    case "6".charCodeAt(0):
                    case "7".charCodeAt(0):
                    case "8".charCodeAt(0):
                    case "9".charCodeAt(0):
                        try {
                        	if(!e.altKey) { // Workspaces feature
                        		if (!e.shiftKey) { // retreive graph configuration from workspace
		                            if (workspaceGraphConfigs.graphConfig[e.which-48] != null) {
		                                newGraphConfig(workspaceGraphConfigs.graphConfig[e.which-48]);
		                            }
		                        } else // store configuration to workspace
		                        {
		                            workspaceGraphConfigs.graphConfig[e.which-48] = graphConfig; // Save current config
		                            prefs.set('workspaceGraphConfigs', workspaceGraphConfigs);      // Store to local cache
		                        }
                        	} else { // Bookmark Feature
                        		if (!e.shiftKey) { // retrieve time from bookmark
		                            if (bookmarkTimes[e.which-48] != null) {
		                                setCurrentBlackboxTime(bookmarkTimes[e.which-48]);
		                                invalidateGraph(); 
		                            }

		                        } else {// store time to bookmark
		                            // Special Case : Shift Alt 0 clears all bookmarks
		                            if(e.which==48) {
		                                bookmarkTimes = null;
		                                for(var i=1; i<=9; i++) {
	                                        $('#status-bar .bookmark-'+ i).css('visibility', 'hidden' );
		                                }
                                        $('#status-bar .bookmark-clear').css('visibility', 'hidden' );
		                            } else {
		                                if(bookmarkTimes==null) bookmarkTimes = new Array();
                                        if (bookmarkTimes[e.which-48] == null) {
                                             bookmarkTimes[e.which-48] = currentBlackboxTime; 		// Save current time to bookmark
                                        } else {
                                             bookmarkTimes[e.which-48] = null; 			            // clear the bookmark
                                        }
                                        $('#status-bar .bookmark-'+(e.which-48)).css('visibility', ((bookmarkTimes[e.which-48]!=null)?('visible'):('hidden')) );
                                        var countBookmarks = 0;
                                        for(var i=0; i<=9; i++) {
                                        	countBookmarks += (bookmarkTimes[i]!=null)?1:0;
                                        }
                                        $('#status-bar .bookmark-clear').css('visibility', ((countBookmarks>0)?('visible'):('hidden')) );

		                            }
		                            invalidateGraph();
		                        }
                        	}
                        } catch(e) {
                            console.log('Workspace feature not functioning');
                        }
                        e.preventDefault();
                    break;
                    case "Z".charCodeAt(0): // Ctrl-Z key to toggle between last graph config and current one - undo
                        try {
                            if(e.ctrlKey) {
                                if (lastGraphConfig != null) {
                                    newGraphConfig(lastGraphConfig);
                                }
                            } else {
                                    (graphZoom==GRAPH_MIN_ZOOM)?setGraphZoom(null):setGraphZoom(GRAPH_MIN_ZOOM);
                                    $(".graph-zoom").val(graphZoom + "%");
                            }
                        } catch(e) {
                            console.log('Workspace toggle feature not functioning');
                        }
                        e.preventDefault();
                    break;
                    
                    // Toolbar shortcuts
                    case " ".charCodeAt(0): // start/stop playback
                            logPlayPause();
                        e.preventDefault();
                    break;
                    case 37: // left arrow (normal scroll, shifted zoom out)
                        if (e.altKey || e.shiftKey) {
                            setGraphZoom(graphZoom - 10.0 - ((e.altKey)?15.0:0.0));
                            $(".graph-zoom").val(graphZoom + "%");
                        } else {
                          logJumpBack();
                        }
                        e.preventDefault();
                    break;
                    case 39: // right arrow (normal scroll, shifted zoom in)
                        if (e.altKey || e.shiftKey) {
                            setGraphZoom(graphZoom + 10.0 + ((e.altKey)?15.0:0.0));
                            $(".graph-zoom").val(graphZoom + "%");
                        } else {
                            logJumpForward();
                        }
                        e.preventDefault();
                    break;
                    case 33: // pgup - Scroll fast
                        logJumpBack(0.25 /* 25% */);
                        e.preventDefault();
                    break;
                    case 34: // pgdn - Scroll fast
                        logJumpForward(0.25 /* 25% */);
                        e.preventDefault();
                    break;
                    case 36: // home - goto start of log
                        logJumpStart();
                        e.preventDefault();
                    break;
                    case 35: // end - goto end of log
                        logJumpEnd();
                        e.preventDefault();
                    break;

                }
            }
        });
        
        $(video).on({
            loadedmetadata: updateCanvasSize,
            error: reportVideoError,
            loadeddata: videoLoaded
        });
        
        var percentageFormat = {
            to: function(value) {
                return value.toFixed(0) + "%";
            },
            from: function(value) {
                return parseFloat(value);
            }
        };
        
        $(".playback-rate-control")
            .noUiSlider({
                start: playbackRate,
                connect: false,
                step: PLAYBACK_RATE_STEP,
                range: {
                    'min': [ PLAYBACK_MIN_RATE ],
                    '50%': [ PLAYBACK_DEFAULT_RATE, PLAYBACK_RATE_STEP ],
                    'max': [ PLAYBACK_MAX_RATE, PLAYBACK_RATE_STEP ]
                },
                format: percentageFormat
            })
            .on("slide change set", function() {
                setPlaybackRate(parseFloat($(this).val()));
            })
            .Link("lower").to($(".playback-rate"));
    
        $(".graph-zoom-control")
            .noUiSlider({
                start: graphZoom,
                connect: false,
                step: GRAPH_ZOOM_STEP,
                range: {
                    'min': [ GRAPH_MIN_ZOOM ],
                    '50%': [ GRAPH_DEFAULT_ZOOM, GRAPH_ZOOM_STEP ],
                    'max': [ GRAPH_MAX_ZOOM, GRAPH_ZOOM_STEP ]
                },
                format: percentageFormat
            })
            .on("slide change set", function() {
                setGraphZoom(parseFloat($(this).val()));
            })
            .Link("lower").to($(".graph-zoom"));
        
        $('.navbar-toggle').click(function(e) {
            $('.navbar-collapse').collapse('toggle');
            
            e.preventDefault();
        });
        
        seekBar.onSeek = setCurrentBlackboxTime;
    });
}

// Boostrap's data API is extremely slow when there are a lot of DOM elements churning, don't use it
$(document).off('.data-api');

window.blackboxLogViewer = new BlackboxLogViewer();